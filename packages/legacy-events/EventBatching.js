/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 * @flow
 */

import invariant from 'shared/invariant';
import {rethrowCaughtError} from 'shared/ReactErrorUtils';

import type {ReactSyntheticEvent} from './ReactSyntheticEventType';
import accumulateInto from './accumulateInto';
import forEachAccumulated from './forEachAccumulated';
import {executeDispatchesInOrder} from './EventPluginUtils';

/**
 * Internal queue of events that have accumulated their dispatches and are waiting to have their dispatches executed.
 * 内部事件队列，这些事件已累积了其派遣，并等待执行其派遣。
 */
// 事件队列
let eventQueue: ?(Array<ReactSyntheticEvent> | ReactSyntheticEvent) = null;

/**
 * Dispatches an event and releases it back into the pool, unless persistent.
 * 派发事件并将其释放回池中，除非是持久的。
 *
 * @param {?object} event Synthetic event to be dispatched.
 * @private
 */
const executeDispatchesAndRelease = function(event: ReactSyntheticEvent) {
  if (event) {
    executeDispatchesInOrder(event);

    if (!event.isPersistent()) {
      event.constructor.release(event);
    }
  }
};
const executeDispatchesAndReleaseTopLevel = function(e) {
  return executeDispatchesAndRelease(e);
};

export function runEventsInBatch(
  events: Array<ReactSyntheticEvent> | ReactSyntheticEvent | null,
) {
  if (events !== null) {
    eventQueue = accumulateInto(eventQueue, events);
  }

  // Set `eventQueue` to null before processing it so that we can tell if more events get enqueued while processing.
  // 在处理 `eventQueue` 之前将其设置为null，这样我们就可以知道在处理过程中是否有更多的事件进入队列。
  const processingEventQueue = eventQueue;
  eventQueue = null;

  if (!processingEventQueue) {
    return;
  }

  forEachAccumulated(processingEventQueue, executeDispatchesAndReleaseTopLevel);
  invariant(
    !eventQueue,
    'processEventQueue(): Additional events were enqueued while processing ' +
      'an event queue. Support for this has not yet been implemented.',
  );
  // This would be a good time to rethrow if any of the event handlers threw.
  rethrowCaughtError();
}
