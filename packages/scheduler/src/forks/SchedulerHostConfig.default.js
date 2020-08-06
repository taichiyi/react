/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {enableIsInputPending} from '../SchedulerFeatureFlags';

export let requestHostCallback;
export let cancelHostCallback;
export let requestHostTimeout;
export let cancelHostTimeout;
export let shouldYieldToHost;
export let requestPaint;
export let getCurrentTime;
export let forceFrameRate;

if (
  // If Scheduler runs in a non-DOM environment, it falls back to a naive implementation using setTimeout.
  // 如果Scheduler在非DOM环境中运行，它将使用setTimeout退回到简单的实现。
  typeof window === 'undefined' ||
  // Check if MessageChannel is supported, too.
  // 检查是否也支持MessageChannel。
  typeof MessageChannel !== 'function'
) {
  //taichiyi 浏览器环境 或 不支持 MessageChannel

  // If this accidentally gets imported in a non-browser environment, e.g. JavaScriptCore, fallback to a naive implementation.
  // //如果此内容在非浏览器环境中意外导入，例如 JavaScriptCore，回退到本地的实现。
  let _callback = null;
  let _timeoutID = null;
  const _flushCallback = function() {
    if (_callback !== null) {
      try {
        const currentTime = getCurrentTime();
        const hasRemainingTime = true;
        _callback(hasRemainingTime, currentTime);
        _callback = null;
      } catch (e) {
        setTimeout(_flushCallback, 0);
        throw e;
      }
    }
  };
  const initialTime = Date.now();
  getCurrentTime = function() {
    return Date.now() - initialTime;
  };
  requestHostCallback = function(cb) {
    if (_callback !== null) {
      // Protect against re-entrancy.
      // 防止再次进入。
      setTimeout(requestHostCallback, 0, cb);
    } else {
      _callback = cb;
      setTimeout(_flushCallback, 0);
    }
  };
  cancelHostCallback = function() {
    _callback = null;
  };
  requestHostTimeout = function(cb, ms) {
    _timeoutID = setTimeout(cb, ms);
  };
  cancelHostTimeout = function() {
    clearTimeout(_timeoutID);
  };
  shouldYieldToHost = function() {
    return false;
  };
  requestPaint = forceFrameRate = function() {};
} else {
  // Capture local references to native APIs, in case a polyfill overrides them.
  const performance = window.performance;
  const Date = window.Date;
  const setTimeout = window.setTimeout;
  const clearTimeout = window.clearTimeout;

  if (typeof console !== 'undefined') {
    // TODO: Scheduler no longer requires these methods to be polyfilled. But
    // maybe we want to continue warning if they don't exist, to preserve the
    // option to rely on it in the future?
    const requestAnimationFrame = window.requestAnimationFrame;
    const cancelAnimationFrame = window.cancelAnimationFrame;
    // TODO: Remove fb.me link
    if (typeof requestAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support requestAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
    if (typeof cancelAnimationFrame !== 'function') {
      console.error(
        "This browser doesn't support cancelAnimationFrame. " +
          'Make sure that you load a ' +
          'polyfill in older browsers. https://fb.me/react-polyfills',
      );
    }
  }

  if (
    typeof performance === 'object' &&
    typeof performance.now === 'function'
  ) {
    getCurrentTime = () => performance.now();
  } else {
    const initialTime = Date.now();
    getCurrentTime = () => Date.now() - initialTime;
  }

  let isMessageLoopRunning = false;
  let scheduledHostCallback = null;
  let taskTimeoutID = -1;

  // Scheduler periodically yields in case there is other work on the main
  // thread, like user events. By default, it yields multiple times per frame.
  // It does not attempt to align with frame boundaries, since most tasks don't
  // need to be frame aligned; for those that do, use requestAnimationFrame.
  let yieldInterval = 5;
  let deadline = 0;

  // TODO: Make this configurable
  // TODO: Adjust this based on priority?
  let maxYieldInterval = 300;
  let needsPaint = false;

  if (
    enableIsInputPending &&
    navigator !== undefined &&
    navigator.scheduling !== undefined &&
    navigator.scheduling.isInputPending !== undefined
  ) {
    const scheduling = navigator.scheduling;
    shouldYieldToHost = function() {
      const currentTime = getCurrentTime();
      if (currentTime >= deadline) {
        // There's no time left. We may want to yield control of the main
        // thread, so the browser can perform high priority tasks. The main ones
        // are painting and user input. If there's a pending paint or a pending
        // input, then we should yield. But if there's neither, then we can
        // yield less often while remaining responsive. We'll eventually yield
        // regardless, since there could be a pending paint that wasn't
        // accompanied by a call to `requestPaint`, or other main thread tasks
        // like network events.
        if (needsPaint || scheduling.isInputPending()) {
          // There is either a pending paint or a pending input.
          return true;
        }
        // There's no pending input. Only yield if we've reached the max
        // yield interval.
        return currentTime >= maxYieldInterval;
      } else {
        // There's still time left in the frame.
        return false;
      }
    };

    requestPaint = function() {
      needsPaint = true;
    };
  } else {
    // `isInputPending` is not available. Since we have no way of knowing if
    // there's pending input, always yield at the end of the frame.
    shouldYieldToHost = function() {
      return getCurrentTime() >= deadline;
    };

    // Since we yield every frame regardless, `requestPaint` has no effect.
    requestPaint = function() {};
  }

  forceFrameRate = function(fps) {
    if (fps < 0 || fps > 125) {
      console.error(
        'forceFrameRate takes a positive int between 0 and 125, ' +
          'forcing framerates higher than 125 fps is not unsupported',
      );
      return;
    }
    if (fps > 0) {
      yieldInterval = Math.floor(1000 / fps);
    } else {
      // reset the framerate
      yieldInterval = 5;
    }
  };

  const performWorkUntilDeadline = () => {
    if (scheduledHostCallback !== null) {
      const currentTime = getCurrentTime();
      // Yield after `yieldInterval` ms, regardless of where we are in the vsync cycle.

      // This means there's always time remaining at the beginning of the message event.
      // 这意味着在消息事件的开始时刻总是有剩余时间。
      deadline = currentTime + yieldInterval;
      const hasTimeRemaining = true;
      try {
        const hasMoreWork = scheduledHostCallback(
          hasTimeRemaining,
          currentTime,
        );
        if (!hasMoreWork) {
          isMessageLoopRunning = false;
          scheduledHostCallback = null;
        } else {
          // If there's more work, schedule the next message event at the end of the preceding one.
          // 如果还有更多工作要做，请将下一个消息事件安排在上一个事件的末尾。
          port.postMessage(null);
        }
      } catch (error) {
        // If a scheduler task throws, exit the current browser task so the error can be observed.
        // 如果调度程序任务抛出，请退出当前浏览器任务，以便可以观察到该错误。
        port.postMessage(null);
        throw error;
      }
    } else {
      isMessageLoopRunning = false;
    }
    // Yielding to the browser will give it a chance to paint, so we can reset this.
    // 浏览器的 Yielding 将使其有机会绘画，因此我们可以重置它。
    needsPaint = false;
  };

  const channel = new MessageChannel();
  const port = channel.port2;
  channel.port1.onmessage = performWorkUntilDeadline;

  requestHostCallback = function(callback) {
    scheduledHostCallback = callback;
    if (!isMessageLoopRunning) {
      isMessageLoopRunning = true;
      port.postMessage(null);
    }
  };

  cancelHostCallback = function() {
    scheduledHostCallback = null;
  };

  requestHostTimeout = function(callback, ms) {
    taskTimeoutID = setTimeout(() => {
      callback(getCurrentTime());
    }, ms);
  };

  cancelHostTimeout = function() {
    clearTimeout(taskTimeoutID);
    taskTimeoutID = -1;
  };
}
