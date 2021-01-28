/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import {
  needsStateRestore,
  restoreStateIfNeeded,
} from './ReactControlledComponent';

import {enableFlareAPI} from 'shared/ReactFeatureFlags';
import {invokeGuardedCallbackAndCatchFirstError} from 'shared/ReactErrorUtils';

// Used as a way to call batchedUpdates when we don't have a reference to the renderer.
// 当我们没有对渲染器的引用时，用作调用batchedUpdates的方式。
// Such as when we're dispatching events or if third party libraries need to call batchedUpdates.
// 例如，当我们触发事件或第三方库需要调用batchedUpdates时。
// Eventually, this API will go away when everything is batched by default.
// 最终，默认情况下所有批处理都将取消此API。
// We'll then have a similar API to opt-out of scheduled work and instead do synchronous work.
// 然后，我们将有一个类似的API以选择退出计划的工作，而是进行同步工作。

// Defaults
let batchedUpdatesImpl = function(fn, bookkeeping) {
  return fn(bookkeeping);
};
let discreteUpdatesImpl = function(fn, a, b, c) {
  return fn(a, b, c);
};
let flushDiscreteUpdatesImpl = function() {};
let batchedEventUpdatesImpl = batchedUpdatesImpl;

let isInsideEventHandler = false;
let isBatchingEventUpdates = false;

function /* ✨ The key logic of controlled component */finishEventHandler() {
  // Here we wait until all updates have propagated,
  // 在这里，我们等待所有更新都传播
  // which is important when using controlled components within layers:
  // 在图层中使用受控组件时，这一点很重要
  // https://github.com/facebook/react/issues/1698
  // Then we restore state of any controlled component.
  const controlledComponentsHavePendingUpdates = needsStateRestore();
  if (controlledComponentsHavePendingUpdates) {
    // If a controlled event was fired, we may need to restore the state of the DOM node back to the controlled value.
    // 如果触发了受控事件，则可能需要将DOM节点的状态恢复回受控值。
    // This is necessary when React bails out of the update without touching the DOM.
    // 当React退出更新而不接触DOM时，这是必需的。
    flushDiscreteUpdatesImpl();
    restoreStateIfNeeded();
  }
}

export function batchedUpdates(fn, bookkeeping) {
  if (isInsideEventHandler) {
    // If we are currently inside another batch, we need to wait until it
    // fully completes before restoring state.
    return fn(bookkeeping);
  }
  isInsideEventHandler = true;
  try {
    return batchedUpdatesImpl(fn, bookkeeping);
  } finally {
    isInsideEventHandler = false;
    finishEventHandler();
  }
}

export function batchedEventUpdates(fn, a, b) {
  if (isBatchingEventUpdates) {
    // If we are currently inside another batch, we need to wait until it fully completes before restoring state.
    // 如果我们当前在另一个批次中，则需要等到它完全完成后再恢复状态。
    return fn(a, b);
  }
  isBatchingEventUpdates = true;
  try {
    return batchedEventUpdatesImpl(fn, a, b);
  } finally {
    isBatchingEventUpdates = false;
    finishEventHandler();
  }
}

// This is for the React Flare event system
export function executeUserEventHandler(fn: any => void, value: any): void {
  const previouslyInEventHandler = isInsideEventHandler;
  try {
    isInsideEventHandler = true;
    const type = typeof value === 'object' && value !== null ? value.type : '';
    invokeGuardedCallbackAndCatchFirstError(type, fn, undefined, value);
  } finally {
    isInsideEventHandler = previouslyInEventHandler;
  }
}

export function discreteUpdates(fn, a, b, c) {
  const prevIsInsideEventHandler = isInsideEventHandler;
  isInsideEventHandler = true;
  try {
    return /* 这个函数是注入的 */discreteUpdatesImpl(fn, a, b, c);
  } finally {
    isInsideEventHandler = prevIsInsideEventHandler;
    if (!isInsideEventHandler) {
      finishEventHandler();
    }
  }
}

let lastFlushedEventTimeStamp = 0;
export function flushDiscreteUpdatesIfNeeded(timeStamp: number) {
  // event.timeStamp isn't overly reliable due to inconsistencies in how different browsers have historically provided the time stamp.
  // 由于历史上不同的浏览器提供时间戳的方式不一致，因此event.timeStamp不太可靠。
  // Some browsers provide high-resolution time stamps for all events, some provide low-resolution time stamps for all events.
  // 一些浏览器为所有事件提供高分辨率时间戳，一些浏览器为所有事件提供低分辨率时间戳。
  // FF < 52 even mixes both time stamps together.
  // FF <52甚至将两个时间戳混合在一起。
  // Some browsers even report negative time stamps or time stamps that are 0 (iOS9) in some cases.
  // 在某些情况下，某些浏览器甚至会报告负时间戳或时间戳为0（iOS9）。
  // Given we are only comparing two time stamps with equality (!==), we are safe from the resolution differences.
  // 鉴于我们只是比较两个时间戳与相等（！==），我们不受分辨率差异的影响。
  // If the time stamp is 0 we bail-out of preventing the flush, which can affect semantics, such as if an earlier flush removes or adds event listeners that are fired in the subsequent flush.
  // 如果时间戳为0，我们就无法阻止刷新，这可能会影响语义，例如如果先前的刷新删除或添加了在后续刷新中激发的事件侦听器。
  // However, this is the same behaviour as we had before this change, so the risks are low.
  // 然而，这和我们在这次变革之前的行为是一样的，所以风险很低。
  if (
    !isInsideEventHandler &&
    (!enableFlareAPI ||
      (timeStamp === 0 || lastFlushedEventTimeStamp !== timeStamp))
  ) {
    lastFlushedEventTimeStamp = timeStamp;
    flushDiscreteUpdatesImpl();
  }
}

// 注入批处理的实现
export function setBatchingImplementation(
  _batchedUpdatesImpl,
  _discreteUpdatesImpl,
  _flushDiscreteUpdatesImpl,
  _batchedEventUpdatesImpl,
) {
  batchedUpdatesImpl = _batchedUpdatesImpl;
  discreteUpdatesImpl = _discreteUpdatesImpl;
  flushDiscreteUpdatesImpl = _flushDiscreteUpdatesImpl;
  batchedEventUpdatesImpl = _batchedEventUpdatesImpl;
}
