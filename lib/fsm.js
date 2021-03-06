/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2019, Joyent, Inc.
 */

module.exports = FSM;

var mod_assert = require('assert-plus');
var mod_crypto = require('crypto');
var mod_util = require('util');
var EventEmitter = require('events').EventEmitter;

var mod_dtrace;

try {
	mod_dtrace = require('dtrace-provider');
} catch (e) {
	mod_dtrace = undefined;
}

var dt;
if (mod_dtrace !== undefined) {
	dt = {};

	dt.provider = mod_dtrace.createDTraceProvider('moorefsm');
	dt.create = dt.provider.addProbe('create-fsm', 'char *', 'char *');
	dt.start = dt.provider.addProbe('transition-start', 'char *', 'char *',
	    'char *', 'char *');
	dt.end = dt.provider.addProbe('transition-end', 'char *', 'char *',
	    'char *', 'char *');
	dt.provider.enable();
}

function FSMStateHandle(fsm, state, link) {
	this.fsh_fsm = fsm;
	this.fsh_link = link;
	this.fsh_state = state;
	this.fsh_valid = true;
	this.fsh_listeners = [];
	this.fsh_timeouts = [];
	this.fsh_intervals = [];
	this.fsh_immediates = [];
	this.fsh_validTransitions = undefined;
	this.fsh_nextState = undefined;
	this.fsh_exitedAt = undefined;
}

FSMStateHandle.prototype.validTransitions = function (states) {
	if (this.fsh_validTransitions !== undefined)
		throw (new Error('FSM validTransitions already set'));
	mod_assert.arrayOfString(states, 'states');
	this.fsh_validTransitions = states;
};

FSMStateHandle.prototype.gotoState = function (state) {
	mod_assert.string(state, 'state');
	if (!this.fsh_valid) {
		throw (new Error('FSM attempted to leave state ' +
		    this.fsh_state + ' towards ' + state + ' via a handle ' +
		    'that was already used to enter state ' +
		    this.fsh_nextState));
	}
	if (this.fsh_validTransitions !== undefined) {
		if (this.fsh_validTransitions.indexOf(state) === -1) {
			throw (new Error('Invalid FSM transition: ' +
			    this.fsh_state + ' => ' + state));
		}
	}
	this.fsh_valid = false;
	this.fsh_nextState = state;
	this.fsh_exitedAt = new Date();
	return (this.fsh_fsm._gotoState(state));
};

FSMStateHandle.prototype.gotoStateOn = function (obj, evt, state) {
	mod_assert.string(state, 'state');

	var self = this;

	self.on(obj, evt, function _gotoStateOn() {
		self.gotoState(state);
	});
};

FSMStateHandle.prototype.gotoStateTimeout = function (timeout, state) {
	mod_assert.string(state, 'state');

	var self = this;

	self.timeout(timeout, function _gotoStateTimeout() {
		self.gotoState(state);
	});
};

FSMStateHandle.prototype.reset = function () {
	this.fsh_valid = true;
	this.fsh_nextState = undefined;
};

/* Disconnect just this handle, returning our parent handle (if any). */
FSMStateHandle.prototype.disconnect = function () {
	var ls = this.fsh_listeners;
	for (var i = 0; i < ls.length; ++i) {
		ls[i][0].removeListener(ls[i][1], ls[i][2]);
	}
	var ts = this.fsh_timeouts;
	for (i = 0; i < ts.length; ++i) {
		clearTimeout(ts[i]);
	}
	var is = this.fsh_intervals;
	for (i = 0; i < is.length; ++i) {
		clearInterval(is[i]);
	}
	var ims = this.fsh_immediates;
	for (i = 0; i < ims.length; ++i) {
		clearImmediate(ims[i]);
	}
	this.fsh_listeners = [];
	this.fsh_timeouts = [];
	this.fsh_intervals = [];
	this.fsh_immediates = [];
	this.fsh_valid = false;
	var link = this.fsh_link;
	this.fsh_link = undefined;
	return (link);
};

/* Disconnect this handle and all parents. */
FSMStateHandle.prototype.disconnectAll = function () {
	var l = this.disconnect();
	if (l !== undefined)
		l.disconnectAll();
};

FSMStateHandle.prototype.on = function (obj, evt, cb) {
	mod_assert.object(obj, 'obj');
	mod_assert.string(evt, 'evt');
	mod_assert.func(cb, 'cb');
	if (!this.fsh_valid) {
		throw (new Error('FSM attempted to set up handler in state ' +
		    this.fsh_state + ' but already called gotoState() to ' +
		    'enter state ' + this.fsh_nextState));
	}
	obj.on(evt, cb);
	this.fsh_listeners.push([obj, evt, cb]);
};

FSMStateHandle.prototype.interval = function (interval, cb) {
	mod_assert.number(interval, 'interval');
	mod_assert.func(cb, 'cb');
	if (!this.fsh_valid) {
		throw (new Error('FSM attempted to set up interval in state ' +
		    this.fsh_state + ' but already called gotoState() to ' +
		    'enter state ' + this.fsh_nextState));
	}
	var timer = setInterval(cb, interval);
	this.fsh_intervals.push(timer);
	return (timer);
};

FSMStateHandle.prototype.timeout = function (timeout, cb) {
	mod_assert.number(timeout, 'timeout');
	mod_assert.func(cb, 'cb');
	if (!this.fsh_valid) {
		throw (new Error('FSM attempted to set up timeout in state ' +
		    this.fsh_state + ' but already called gotoState() to ' +
		    'enter state ' + this.fsh_nextState));
	}
	var timer = setTimeout(cb, timeout);
	this.fsh_timeouts.push(timer);
	return (timer);
};

FSMStateHandle.prototype.immediate = function (cb) {
	mod_assert.func(cb, 'cb');
	if (!this.fsh_valid) {
		throw (new Error('FSM attempted to set up immediate in state ' +
		    this.fsh_state + ' but already called gotoState() to ' +
		    'enter state ' + this.fsh_nextState));
	}
	var timer = setImmediate(cb);
	this.fsh_immediates.push(timer);
	return (timer);
};

FSMStateHandle.prototype.callback = function (cb) {
	mod_assert.func(cb, 'cb');
	if (!this.fsh_valid) {
		throw (new Error('FSM attempted to set up callback in state ' +
		    this.fsh_state + ' but already called gotoState() to ' +
		    'enter state ' + this.fsh_nextState));
	}
	var s = this;
	return (function () {
		var args = arguments;
		if (s.fsh_valid)
			return (cb.apply(this, args));
		return (undefined);
	});
};

/*
 * fsm.js: a small library for Moore finite state machines.
 *
 * A Moore machine takes actions only on entry to a new state (it's an
 * edge-triggered machine). As a result, each valid state of an FSM subclass
 * must have a function named state_X where X is the name of the state, to be
 * run on entry to that state.
 *
 * The state function takes one argument -- the state handle. This is used in
 * order to gang together callbacks that result in a state transition out of
 * this state. The "on" function acts on an EventEmitter, "timeout" is a
 * wrapper around setTimeout. The state handle also contains the "gotoState"
 * method, which is used to transition to a new state. The idea behind using
 * the on/timeout/etc functions is that all callbacks you register in this way
 * will automatically get de-registered (and any timers cleaned up) as soon as
 * the FSM leaves its current state. This way we avoid any stale callbacks
 * from a previous state being called with new data.
 *
 * FSM also supports "sub-states", which share their callbacks with the rest of
 * their family. They are also considered equivalent to the parent state when
 * used with "onState".
 */
function FSM(defState) {
	mod_assert.string(defState, 'default state');
	this.fsm_id = FSM.genId();
	this.fsm_clsname = this.constructor.name;
	if (this.fsm_clsname.length === 0)
		this.fsm_clsname = 'FSM';
	this.fsm_history = [];
	this.fsm_handle = undefined;
	this.fsm_inTransition = false;
	if (this.fsm_allStateEvents === undefined)
		this.fsm_allStateEvents = [];
	this.fsm_state = undefined;
	this.fsm_toEmit = [];
	EventEmitter.call(this);
	if (dt !== undefined) {
		var self = this;
		dt.create.fire(function () {
			return ([self.fsm_clsname, self.fsm_id]);
		});
	}
	this._gotoState(defState);
}
mod_util.inherits(FSM, EventEmitter);

FSM.genId = function () {
	var b = mod_crypto.randomBytes(8);
	/*
	 * Use slice() to strip off the trailing "=" padding, as the last 2
	 * chars are always the same and make for unnecessary noise.
	 */
	return (b.toString('base64').slice(0, 11));
};

FSM.prototype.getState = function () {
	return (this.fsm_state);
};

FSM.prototype.isInState = function (state) {
	mod_assert.string(state, 'state');
	return (this.fsm_state === state ||
	    this.fsm_state.indexOf(state + '.') === 0);
};

FSM.prototype.allStateEvent = function (evt) {
	mod_assert.string(evt, 'event');
	if (this.fsm_allStateEvents === undefined)
		this.fsm_allStateEvents = [];
	this.fsm_allStateEvents.push(evt);
};

/* Transition the FSM to a new state. */
FSM.prototype._gotoState = function (state) {
	mod_assert.string(state, 'state');

	if (this.fsm_inTransition) {
		mod_assert.ok(this.fsm_nextState === undefined);
		this.fsm_nextState = state;
		return;
	}

	var self = this;
	var oldState = this.fsm_state;
	if (dt !== undefined) {
		dt.start.fire(function () {
			return ([self.fsm_clsname, self.fsm_id,
			    oldState, state]);
		});
	}

	/*
	 * First, kill event handlers and timers from our previous state, as
	 * needed.
	 */
	var parts = (this.fsm_state ? this.fsm_state.split('.') : ['']);
	var newParts = state.split('.');
	if (newParts.length > 2)
		throw (new Error('Invalid FSM destination state: ' + state));
	if (this.fsm_handle !== undefined) {
		if (parts[0] === newParts[0] && parts[1] === undefined &&
		    newParts[1] !== undefined) {
			/*
			 * e.g. 'connected' => 'connected.idle'. Don't
			 * disconnect anything.
			 */
			this.fsm_handle.reset();
		} else if (parts[0] === newParts[0] && parts[1] !== undefined &&
		    newParts[1] !== undefined) {
			/*
			 * e.g. 'connected.idle' => 'connected.busy'. Just
			 * disconnect the things we set up in 'connected.idle'
			 * while leaving things from 'connected' alone. Also
			 * reset the parent handle in case it was the cause of
			 * the transition.
			 *
			 * Note we end up here if we're re-entering the same
			 * exact state, too.
			 */
			this.fsm_handle = this.fsm_handle.disconnect();
			if (this.fsm_handle !== undefined)
				this.fsm_handle.reset();
		} else {
			/*
			 * e.g. 'connected' => 'closing'. Disconnect all
			 * handlers (including from any parent states).
			 */
			this.fsm_handle.disconnectAll();
			this.fsm_handle = undefined;
		}
	}

	var f = this['state_' + newParts[0]];
	if (typeof (f) !== 'function')
		throw (new Error('Unknown FSM state: ' + state));
	if (newParts[1] !== undefined) {
		f = f[newParts[1]];
		if (typeof (f) !== 'function')
			throw (new Error('Unknown FSM sub-state: ' + state));
	}
	this.fsm_state = state;

	this.fsm_handle = new FSMStateHandle(this, state, this.fsm_handle);

	this.fsm_history.push([state, new Date()]);
	if (this.fsm_history.length >= 8)
		this.fsm_history.shift();

	this.fsm_inTransition = true;
	f.call(this, this.fsm_handle);
	this.fsm_inTransition = false;

	this.fsm_allStateEvents.forEach(function (evt) {
		if (self.listeners(evt).length < 1) {
			throw (new Error('FSM consistency error: ' +
			    'state entry function for "' + state + '" did ' +
			    'not add a handler for all-state event "' +
			    evt + '"'));
		}
	});

	this.fsm_toEmit.push(state);
	if (this.fsm_toEmit.length === 1) {
		setImmediate(function () {
			var ss = self.fsm_toEmit;
			self.fsm_toEmit = [];
			ss.forEach(function (s) {
				self.emit('stateChanged', s);
			});
		});
	}

	if (dt !== undefined) {
		dt.end.fire(function () {
			return ([self.fsm_clsname, self.fsm_id,
			    oldState, state]);
		});
	}

	var next = this.fsm_nextState;
	if (next !== undefined) {
		this.fsm_nextState = undefined;
		this._gotoState(next);
	}
};
