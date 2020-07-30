/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import invariant from 'shared/invariant';

let invokeGuardedCallbackImpl = function<A, B, C, D, E, F, Context>(
  name: string | null,
  func: (a: A, b: B, c: C, d: D, e: E, f: F) => mixed,
  context: Context,
  a: A,
  b: B,
  c: C,
  d: D,
  e: E,
  f: F,
) {
  const funcArgs = Array.prototype.slice.call(arguments, 3);
  try {
    func.apply(context, funcArgs);
  } catch (error) {
    this.onError(error);
  }
};

if (__DEV__) {
  // In DEV mode, we swap out invokeGuardedCallback for a special version that plays more nicely with the browser's DevTools.
  // 在DEV模式下，我们将invokeGuardedCallback换成一个特殊版本，可以与浏览器的DevTools更好地配合使用。
  // The idea is to preserve "Pause on exceptions" behavior.
  // 这个想法是保留“异常暂停”的行为。
  // Because React wraps all user-provided functions in invokeGuardedCallback, and the production version of invokeGuardedCallback uses a try-catch, all user exceptions are treated like caught exceptions, and the DevTools won't pause unless the developer takes the extra step of enabling pause on caught exceptions.
  // 因为React将所有用户提供的函数包装在invokeGuardedCallback中，并且生产版本的invokeGuardedCallback使用try-catch，所以所有用户异常都像捕获的异常一样对待，除非开发人员采取额外的步骤来启用暂停，否则DevTools不会暂停 捕获异常。
  // This is unintuitive, though, because even though React has caught the error, from the developer's perspective, the error is uncaught.
  // 但是，这是不直观的，因为即使React捕获了错误，从开发人员的角度来看，该错误也未被发现。
  //
  // To preserve the expected "Pause on exceptions" behavior, we don't use a try-catch in DEV.
  // 为了保留预期的“异常暂停”行为，我们在DEV中不使用try-catch。
  // Instead, we synchronously dispatch a fake event to a fake DOM node, and call the user-provided callback from inside an event handler for that fake event.
  // 相反，我们将虚假事件同步发送到虚假DOM节点，并从该虚假事件的事件处理程序内部调用用户提供的回调。
  // If the callback throws, the error is "captured" using a global event handler.
  // 如果回调抛出，则使用全局事件处理程序“捕获”错误。
  // But because the error happens in a different event loop context, it does not interrupt the normal program flow.
  // 但是因为错误发生在不同的事件循环上下文中，所以它不会中断正常的程序流。
  // Effectively, this gives us try-catch behavior without actually using try-catch. Neat!
  // 实际上，这为我们提供了try-catch行为，而无需实际使用try-catch。整齐！

  // Check that the browser supports the APIs we need to implement our special DEV version of invokeGuardedCallback
  // 检查浏览器是否支持实现特殊的DEV版本的invokeGuardedCallback所需的API
  if (
    typeof window !== 'undefined' &&
    typeof window.dispatchEvent === 'function' &&
    typeof document !== 'undefined' &&
    typeof document.createEvent === 'function'
  ) {
    const fakeNode = document.createElement('react');

    const invokeGuardedCallbackDev = function<A, B, C, D, E, F, Context>(
      name: string | null,
      func: (a: A, b: B, c: C, d: D, e: E, f: F) => mixed,
      context: Context,
      a: A,
      b: B,
      c: C,
      d: D,
      e: E,
      f: F,
    ) {
      // If document doesn't exist we know for sure we will crash in this method
      // when we call document.createEvent(). However this can cause confusing
      // errors: https://github.com/facebookincubator/create-react-app/issues/3482
      // So we preemptively throw with a better message instead.
      invariant(
        typeof document !== 'undefined',
        'The `document` global was defined when React was initialized, but is not ' +
          'defined anymore. This can happen in a test environment if a component ' +
          'schedules an update from an asynchronous callback, but the test has already ' +
          'finished running. To solve this, you can either unmount the component at ' +
          'the end of your test (and ensure that any asynchronous operations get ' +
          'canceled in `componentWillUnmount`), or you can change the test itself ' +
          'to be asynchronous.',
      );
      const evt = document.createEvent('Event');

      // Keeps track of whether the user-provided callback threw an error. We
      // set this to true at the beginning, then set it to false right after
      // calling the function. If the function errors, `didError` will never be
      // set to false. This strategy works even if the browser is flaky and
      // fails to call our global error handler, because it doesn't rely on
      // the error event at all.
      let didError = true;

      // Keeps track of the value of window.event so that we can reset it
      // during the callback to let user code access window.event in the
      // browsers that support it.
      let windowEvent = window.event;

      // Keeps track of the descriptor of window.event to restore it after event
      // dispatching: https://github.com/facebook/react/issues/13688
      const windowEventDescriptor = Object.getOwnPropertyDescriptor(
        window,
        'event',
      );

      // Create an event handler for our fake event. We will synchronously
      // dispatch our fake event using `dispatchEvent`. Inside the handler, we
      // call the user-provided callback.
      const funcArgs = Array.prototype.slice.call(arguments, 3);
      function callCallback() {
        // We immediately remove the callback from event listeners so that nested `invokeGuardedCallback` calls do not clash.
        // 我们会立即从事件监听器中删除回调，以免嵌套的`invokeGuardedCallback`调用发生冲突。
        // Otherwise, a nested call would trigger the fake event handlers of any call higher in the stack.
        // 否则，嵌套调用将触发堆栈中任何更高级别调用的虚假事件处理程序。
        fakeNode.removeEventListener(evtType, callCallback, false);

        // We check for window.hasOwnProperty('event') to prevent the
        // window.event assignment in both IE <= 10 as they throw an error
        // "Member not found" in strict mode, and in Firefox which does not
        // support window.event.
        if (
          typeof window.event !== 'undefined' &&
          window.hasOwnProperty('event')
        ) {
          window.event = windowEvent;
        }

        func.apply(context, funcArgs);
        didError = false;
      }

      // Create a global error event handler. We use this to capture the value
      // that was thrown. It's possible that this error handler will fire more
      // than once; for example, if non-React code also calls `dispatchEvent`
      // and a handler for that event throws. We should be resilient to most of
      // those cases. Even if our error event handler fires more than once, the
      // last error event is always used. If the callback actually does error,
      // we know that the last error event is the correct one, because it's not
      // possible for anything else to have happened in between our callback
      // erroring and the code that follows the `dispatchEvent` call below. If
      // the callback doesn't error, but the error event was fired, we know to
      // ignore it because `didError` will be false, as described above.
      let error;
      // Use this to track whether the error event is ever called.
      let didSetError = false;
      let isCrossOriginError = false;

      function handleWindowError(event) {
        error = event.error;
        didSetError = true;
        if (error === null && event.colno === 0 && event.lineno === 0) {
          isCrossOriginError = true;
        }
        if (event.defaultPrevented) {
          // Some other error handler has prevented default.
          // Browsers silence the error report if this happens.
          // We'll remember this to later decide whether to log it or not.
          if (error != null && typeof error === 'object') {
            try {
              error._suppressLogging = true;
            } catch (inner) {
              // Ignore.
            }
          }
        }
      }

      // Create a fake event type.
      // 创建一个假事件类型。
      const evtType = `react-${name ? name : 'invokeguardedcallback'}`;

      // Attach our event handlers
      // 附加我们的事件处理程序
      window.addEventListener('error', handleWindowError);
      fakeNode.addEventListener(evtType, callCallback, false);

      // Synchronously dispatch our fake event.
      // 同步调度我们的假事件。
      // If the user-provided function errors, it will trigger our global error handler.
      // 如果用户提供的功能出错，它将触发我们的全局错误处理程序。
      evt.initEvent(evtType, false, false);
      fakeNode.dispatchEvent(evt);

      if (windowEventDescriptor) {
        Object.defineProperty(window, 'event', windowEventDescriptor);
      }

      if (didError) {
        if (!didSetError) {
          // The callback errored, but the error event never fired.
          error = new Error(
            'An error was thrown inside one of your components, but React ' +
              "doesn't know what it was. This is likely due to browser " +
              'flakiness. React does its best to preserve the "Pause on ' +
              'exceptions" behavior of the DevTools, which requires some ' +
              "DEV-mode only tricks. It's possible that these don't work in " +
              'your browser. Try triggering the error in production mode, ' +
              'or switching to a modern browser. If you suspect that this is ' +
              'actually an issue with React, please file an issue.',
          );
        } else if (isCrossOriginError) {
          error = new Error(
            "A cross-origin error was thrown. React doesn't have access to " +
              'the actual error object in development. ' +
              'See https://fb.me/react-crossorigin-error for more information.',
          );
        }
        this.onError(error);
      }

      // Remove our event listeners
      window.removeEventListener('error', handleWindowError);
    };

    invokeGuardedCallbackImpl = invokeGuardedCallbackDev;
  }
}

export default invokeGuardedCallbackImpl;
