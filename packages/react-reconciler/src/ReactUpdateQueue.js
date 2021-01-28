/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// UpdateQueue is a linked list of prioritized updates.
// UpdateQueue 是优先更新的链表。
//
// Like fibers, update queues come in pairs:
// 像 fibers 一样，update 队列是成对出现的：
// a current queue, which represents the visible state of the screen,
// 一个是 current 队列，它表示屏幕的可见状态；
// and a work-in-progress queue, which can be mutated and processed asynchronously before it is committed — a form of double buffering.
// 一个 work-in-progress 队列，可以在提交前进行异步更改和处理，这是双重缓冲的一种形式。
// If a work-in-progress render is discarded before finishing, we create a new work-in-progress by cloning the current queue.
// 如果一个 work-in-progress 渲染在完成前被丢弃，我们通过克隆 current 队列来创建一个新的 work-in-progress 。
//
// Both queues share a persistent, singly-linked list structure.
// 两个队列共享一个持久的单链接列表结构。
// To schedule an update, we append it to the end of both queues.
// 为了安排一个 update ，我们将其附加到两个队列的末尾。
// Each queue maintains a pointer to first update in the persistent list that hasn't been processed.
// 每个队列都维护一个指针，指向持久列表中尚未处理的第一个 update 。
// The work-in-progress pointer always has a position equal to or greater than the current queue, since we always work on that one.
// “work in progress”指针的位置始终等于或大于 current 队列，因为我们总是在该队列上工作。
// The current queue's pointer is only updated during the commit phase, when we swap in the work-in-progress.
// current 队列的指针只在提交阶段更新，即我们在“work-in-progress”中进行交换。
//
// For example:
//
//   Current pointer:           A - B - C - D - E - F
//   Work-in-progress pointer:              D - E - F
//                                          ^
//                                          The work-in-progress queue has processed more updates than current.
//                                          work-in-progress 队列已处理的 updates 多于 current updates 。
//
// The reason we append to both queues is because otherwise we might drop updates without ever processing them.
// 我们附加到这两个队列的原因是，否则我们可能会丢弃 update ，而从不处理它们。
// For example, if we only add updates to the work-in-progress queue, some updates could be lost whenever a work-in-progress render restarts by cloning from current.
// 例如，如果我们只将 update 添加到 work-in-progress 队列中，则每当通过克隆 Current 重新启动 work-in-progress 渲染时，可能会丢失某些 update 。
// Similarly, if we only add updates to the current queue, the updates will be lost whenever an already in-progress queue commits and swaps with the current queue.
// 类似的，如果我们仅将 update 添加到 current 队列中，则每当已提交的 work-in-progress 队列提交 和 current 队列交换时， update 将丢失。
// However, by adding to both queues, we guarantee that the update will be part of the next work-in-progress.
// 但是，通过添加到两个队列，我们​​保证 update 将成为下一个 work-in-progress 的一部分。
// (And because the work-in-progress queue becomes the current queue once it commits, there's no danger of applying the same update twice.)
// （而且，由于进行中的工作队列一旦提交便成为当前队列，因此不存在用一个 update 应用两次的危险。）
//
// Prioritization
// 优先级
// --------------
//
// Updates are not sorted by priority, but by insertion; new updates are always appended to the end of the list.
// Updates 不是按优先级排序，而是按插入排序；新的 updates 总是附加在列表的末尾。
//
// The priority is still important, though. When processing the update queue during the render phase, only the updates with sufficient priority are included in the result.
// 但是，优先级仍然很重要。在渲染阶段处理 update 队列时，结果中仅包含具有足够优先级的 updates 。
// If we skip an update because it has insufficient priority, it remains in the queue to be processed later, during a lower priority render.
// 如果由于优先级不足而跳过 update ，则该 update 将保留在队列中，以便稍后在较低优先级渲染期间进行处理。
// Crucially, all updates subsequent to a skipped update also remain in the queue *regardless of their priority*.
// 至关重要的是，跳过 updates 之后的所有 update 也将保留在队列中，*而不管其优先级如何*。
// That means high priority updates are sometimes processed twice, at two separate priorities.
// 这意味着高优先级的 updates 有时会以两个不同的优先级处理两次。
// We also keep track of a base state, that represents the state before the first update in the queue is applied.
// 我们还跟踪一个基本 state ，该 state 表示应用队列中的第一个更新之前的 state 。

//
// For example:
//
//   Given a base state of '', and the following queue of updates
//   假设基本 state 为''，以及以下的 updates 队列
//
//     A1 - B2 - C1 - D2
//
//   where the number indicates the priority, and the update is applied to the previous state by appending a letter,
//   其中数字表示优先级，并且通过附加字母将更新应用于先前的 state ，
//   React will process these updates as two separate renders, one per distinct priority level:
//   React 将把这些 updates 作为两个单独的渲染处理，每个不同的优先级一个：
//
//   First render, at priority 1:
//     Base state: ''
//     Updates: [A1, C1]
//     Result state: 'AC'
//
//   Second render, at priority 2:
//     Base state: 'A'            <-  The base state does not include C1, because B2 was skipped.
//
//     Updates: [B2, C1, D2]      <-  C1 was rebased on top of B2 // C1重新定位在B2之上
//     Result state: 'ABCD'
//
// Because we process updates in insertion order, and rebase high priority updates when preceding updates are skipped, the final result is deterministic regardless of priority.
// 因为我们按插入顺序处理更新，并且在跳过之前的更新时对高优先级更新进行重新设置，所以无论优先级如何，最终结果都是确定性的。
// Intermediate state may vary according to system resources, but the final state is always the same.
// 中间状态可能因系统资源而异，但最终状态始终相同。

import type {Fiber} from './ReactFiber';
import type {ExpirationTime} from './ReactFiberExpirationTime';
import type {SuspenseConfig} from './ReactFiberSuspenseConfig';
import type {ReactPriorityLevel} from './SchedulerWithReactIntegration';

import {NoWork} from './ReactFiberExpirationTime';
import {
  enterDisallowedContextReadInDEV,
  exitDisallowedContextReadInDEV,
} from './ReactFiberNewContext';
import {Callback, ShouldCapture, DidCapture} from 'shared/ReactSideEffectTags';
import {ClassComponent} from 'shared/ReactWorkTags';

import {debugRenderPhaseSideEffectsForStrictMode} from 'shared/ReactFeatureFlags';

import {StrictMode} from './ReactTypeOfMode';
import {
  markRenderEventTimeAndConfig,
  markUnprocessedUpdateTime,
} from './ReactFiberWorkLoop';

import invariant from 'shared/invariant';
import warningWithoutStack from 'shared/warningWithoutStack';
import {getCurrentPriorityLevel} from './SchedulerWithReactIntegration';

export type Update<State> = {
  expirationTime: ExpirationTime,
  suspenseConfig: null | SuspenseConfig,

  tag: 0 | 1 | 2 | 3,
  payload: any,
  callback: (() => mixed) | null,

  next: Update<State> | null,
  nextEffect: Update<State> | null,

  //DEV only
  priority?: ReactPriorityLevel,
};

export type UpdateQueue<State> = {
  baseState: State,

  firstUpdate: Update<State> | null,
  lastUpdate: Update<State> | null,

  firstCapturedUpdate: Update<State> | null,
  lastCapturedUpdate: Update<State> | null,

  firstEffect: Update<State> | null,
  lastEffect: Update<State> | null,

  firstCapturedEffect: Update<State> | null,
  lastCapturedEffect: Update<State> | null,
};

// React 的 State 更新分为四种情况，他们分别对应 Update 的 tag 属性的四个值：
export const UpdateState = 0; // 更新 State
export const ReplaceState = 1; // 替换 State
export const ForceUpdate = 2; // 强制 State
export const CaptureUpdate = 3; // 捕获 State

// Global state that is reset at the beginning of calling `processUpdateQueue`.
// It should only be read right after calling `processUpdateQueue`, via
// `checkHasForceUpdateAfterProcessing`.
let hasForceUpdate = false;

let didWarnUpdateInsideUpdate;
let currentlyProcessingQueue;
export let resetCurrentlyProcessingQueue;
if (__DEV__) {
  didWarnUpdateInsideUpdate = false;
  currentlyProcessingQueue = null;
  resetCurrentlyProcessingQueue = () => {
    currentlyProcessingQueue = null;
  };
}

// 创建-state更新队列
export function createUpdateQueue<State>(baseState: State): UpdateQueue<State> {
  const queue: UpdateQueue<State> = {
    baseState,
    firstUpdate: null,
    lastUpdate: null,
    firstCapturedUpdate: null,
    lastCapturedUpdate: null,
    firstEffect: null,
    lastEffect: null,
    firstCapturedEffect: null,
    lastCapturedEffect: null,
  };
  return queue;
}

function cloneUpdateQueue<State>(
  currentQueue: UpdateQueue<State>,
): UpdateQueue<State> {
  const queue: UpdateQueue<State> = {
    baseState: currentQueue.baseState,
    firstUpdate: currentQueue.firstUpdate,
    lastUpdate: currentQueue.lastUpdate,

    // TODO: With resuming, if we bail out and resuse the child tree, we should
    // keep these effects.
    firstCapturedUpdate: null,
    lastCapturedUpdate: null,

    firstEffect: null,
    lastEffect: null,

    firstCapturedEffect: null,
    lastCapturedEffect: null,
  };
  return queue;
}

//taichiyi fiber reconciler 将 fiber 的state更新抽象为 Update 单向链表：
//taichiyi createUpdate 函数用于创建 Update。getStateFromUpdate 函数用于通过 Update 获取新的 fiber state，其处理方式基于 tag 类型。
//taichiyi 如 tag 为 UpdateState 时，getStateFromUpdate 将取用更新前的 state 值，并混入 payload 返回值或 payload 本身，作为新的 state 值返回。
//taichiyi “payload 返回值”指的是 payload 本身是一个函数，它会以组件实例作为上下文，并以 prevState、nextProps 作为参数。
//taichiyi Update 和 UpdateQueue 的关系，参见 https://oss.taichiyi.com/markdown/1592385506824.png
export function createUpdate(
  expirationTime: ExpirationTime,
  suspenseConfig: null | SuspenseConfig,
): Update<*> {
  let update: Update<*> = {
    expirationTime,
    suspenseConfig,

    //taichiyi 更新类型
    tag: UpdateState,
    //taichiyi state变更函数或新state本身
    payload: null,
    //taichiyi 回调，作用于 fiber.effectTag，并将 callback 作为 side-effects 回调
    callback: null,

    //taichiyi 指向下一个 Update
    next: null,
    nextEffect: null,
  };
  if (__DEV__) {
    update.priority = getCurrentPriorityLevel();
  }
  return update;
}

// 把“更新”添加到 state 队列
function appendUpdateToQueue<State>(
  queue: UpdateQueue<State>,
  update: Update<State>,
) {
  // Append the update to the end of the list.
  if (queue.lastUpdate === null) {
    // Queue is empty
    queue.firstUpdate = queue.lastUpdate = update;
  } else {
    queue.lastUpdate.next = update;
    queue.lastUpdate = update;
  }
}

// 将 update 添加到 pendingQueue 队列中，典型如类组件在 setState 方法调用期间将 update 添加到 pendingQueue 中。
export function enqueueUpdate<State>(fiber: Fiber, update: Update<State>) {
  // Update queues are created lazily.
  const alternate = fiber.alternate;
  let queue1;
  let queue2;
  if (alternate === null) {
    // There's only one fiber.
    queue1 = fiber.updateQueue;
    queue2 = null;
    if (queue1 === null) {
      queue1 = fiber.updateQueue = createUpdateQueue(fiber.memoizedState);
    }
  } else {
    // There are two owners.
    queue1 = fiber.updateQueue;
    queue2 = alternate.updateQueue;
    if (queue1 === null) {
      if (queue2 === null) {
        // Neither fiber has an update queue. Create new ones.
        queue1 = fiber.updateQueue = createUpdateQueue(fiber.memoizedState);
        queue2 = alternate.updateQueue = createUpdateQueue(
          alternate.memoizedState,
        );
      } else {
        // Only one fiber has an update queue. Clone to create a new one.
        queue1 = fiber.updateQueue = cloneUpdateQueue(queue2);
      }
    } else {
      if (queue2 === null) {
        // Only one fiber has an update queue. Clone to create a new one.
        queue2 = alternate.updateQueue = cloneUpdateQueue(queue1);
      } else {
        // Both owners have an update queue.
      }
    }
  }
  if (queue2 === null || queue1 === queue2) {
    // There's only a single queue.
    appendUpdateToQueue(queue1, update);
  } else {
    // There are two queues. We need to append the update to both queues,
    // while accounting for the persistent structure of the list — we don't
    // want the same update to be added multiple times.
    if (queue1.lastUpdate === null || queue2.lastUpdate === null) {
      // One of the queues is not empty. We must add the update to both queues.
      appendUpdateToQueue(queue1, update);
      appendUpdateToQueue(queue2, update);
    } else {
      // Both queues are non-empty. The last update is the same in both lists,
      // because of structural sharing. So, only append to one of the lists.
      appendUpdateToQueue(queue1, update);
      // But we still need to update the `lastUpdate` pointer of queue2.
      queue2.lastUpdate = update;
    }
  }

  if (__DEV__) {
    if (
      fiber.tag === ClassComponent &&
      (currentlyProcessingQueue === queue1 ||
        (queue2 !== null && currentlyProcessingQueue === queue2)) &&
      !didWarnUpdateInsideUpdate
    ) {
      warningWithoutStack(
        false,
        'An update (setState, replaceState, or forceUpdate) was scheduled ' +
          'from inside an update function. Update functions should be pure, ' +
          'with zero side-effects. Consider using componentDidUpdate or a ' +
          'callback.',
      );
      didWarnUpdateInsideUpdate = true;
    }
  }
}

export function enqueueCapturedUpdate<State>(
  workInProgress: Fiber,
  update: Update<State>,
) {
  // Captured updates go into a separate list, and only on the work-in-
  // progress queue.
  let workInProgressQueue = workInProgress.updateQueue;
  if (workInProgressQueue === null) {
    workInProgressQueue = workInProgress.updateQueue = createUpdateQueue(
      workInProgress.memoizedState,
    );
  } else {
    // TODO: I put this here rather than createWorkInProgress so that we don't
    // clone the queue unnecessarily. There's probably a better way to
    // structure this.
    workInProgressQueue = ensureWorkInProgressQueueIsAClone(
      workInProgress,
      workInProgressQueue,
    );
  }

  // Append the update to the end of the list.
  if (workInProgressQueue.lastCapturedUpdate === null) {
    // This is the first render phase update
    workInProgressQueue.firstCapturedUpdate = workInProgressQueue.lastCapturedUpdate = update;
  } else {
    workInProgressQueue.lastCapturedUpdate.next = update;
    workInProgressQueue.lastCapturedUpdate = update;
  }
}

function ensureWorkInProgressQueueIsAClone<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
): UpdateQueue<State> {
  const current = workInProgress.alternate;
  if (current !== null) {
    // If the work-in-progress queue is equal to the current queue, we need to clone it first.
    // 如果 work-in-progress 队列等于当前队列，则需要先克隆它。
    if (queue === current.updateQueue) {
      queue = workInProgress.updateQueue = cloneUpdateQueue(queue);
    }
  }
  return queue;
}

function getStateFromUpdate<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  update: Update<State>,
  prevState: State,
  nextProps: any,
  instance: any,
): any {
  switch (update.tag) {
    case ReplaceState: {
      const payload = update.payload;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictMode
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        const nextState = payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          exitDisallowedContextReadInDEV();
        }
        return nextState;
      }
      // State object
      return payload;
    }
    case CaptureUpdate: {
      workInProgress.effectTag =
        (workInProgress.effectTag & ~ShouldCapture) | DidCapture;
    }
    // Intentional fallthrough
    // 故意掉队
    case UpdateState: {
      const payload = update.payload;
      let partialState;
      if (typeof payload === 'function') {
        // Updater function
        if (__DEV__) {
          enterDisallowedContextReadInDEV();
          if (
            debugRenderPhaseSideEffectsForStrictMode &&
            workInProgress.mode & StrictMode
          ) {
            payload.call(instance, prevState, nextProps);
          }
        }
        partialState = /* ✨ 如果 setState 传的是函数，则在这里被调用 */payload.call(instance, prevState, nextProps);
        if (__DEV__) {
          exitDisallowedContextReadInDEV();
        }
      } else {
        // Partial state object
        // 部分 state 对象
        partialState = payload;
      }
      if (partialState === null || partialState === undefined) {
        // Null and undefined are treated as no-ops.
        return prevState;
      }
      // Merge the partial state and the previous state.
      return /* ✨ setState 所传的 state 在这里合并为新的 state 对象 */Object.assign({}, prevState, partialState);
    }
    case ForceUpdate: {
      hasForceUpdate = true;
      return prevState;
    }
  }
  return prevState;
}

export function processUpdateQueue<State>(
  workInProgress: Fiber,
  queue: UpdateQueue<State>,
  props: any,
  instance: any,
  renderExpirationTime: ExpirationTime,
): void {
  hasForceUpdate = false;

  queue = ensureWorkInProgressQueueIsAClone(workInProgress, queue);

  if (__DEV__) {
    currentlyProcessingQueue = queue;
  }

  // These values may change as we process the queue.
  // 当我们处理队列时，这些值可能会更改。
  let newBaseState = queue.baseState;
  let newFirstUpdate = null;
  let newExpirationTime = NoWork;

  // Iterate through the list of updates to compute the result.
  // 通过更新列表进行迭代以计算结果。
  let update = queue.firstUpdate;
  let resultState = newBaseState;
  while (update !== null) {
    const updateExpirationTime = update.expirationTime;
    if (updateExpirationTime < renderExpirationTime) {
      // This update does not have sufficient priority. Skip it.
      // 此更新没有足够的优先级。跳过它。
      if (newFirstUpdate === null) {
        // This is the first skipped update. It will be the first update in the new list.
        // 这是第一个跳过的更新。这将是新列表中的第一次更新。
        newFirstUpdate = update;
        // Since this is the first update that was skipped, the current result is the new base state.
        // 由于这是跳过的第一个更新，因此当前结果是新的基本 state。
        newBaseState = resultState;
      }
      // Since this update will remain in the list, update the remaining expiration time.
      // 由于此更新将保留在列表中，因此请更新剩余的过期时间。
      if (newExpirationTime < updateExpirationTime) {
        newExpirationTime = updateExpirationTime;
      }
    } else {
      // This update does have sufficient priority.
      // 此更新确实具有足够的优先级。

      // Mark the event time of this update as relevant to this render pass.
      // 将此更新的事件时间标记为与此渲染过程相关。

      // TODO: This should ideally use the true event time of this update rather than its priority which is a derived and not reverseable value.
      // 待办事项：理想情况下，应使用此更新的真实事件时间，而不要使用优先级，后者是派生且不可逆的值。
      // TODO: We should skip this update if it was already committed but currently we have no way of detecting the difference between a committed and suspended update here.
      // 待办事项：如果已经提交了此更新，则应跳过此更新，但是当前我们无法在此处检测已提交和挂起的更新之间的差异。
      markRenderEventTimeAndConfig(updateExpirationTime, update.suspenseConfig);

      // Process it and compute a new result.
      // 处理它并计算新结果。
      resultState = /* ✨ 计算出类组件最新的 state */getStateFromUpdate(
        workInProgress,
        queue,
        update,
        resultState,
        props,
        instance,
      );
      const callback = update.callback;
      if (callback !== null) {
        workInProgress.effectTag |= Callback;
        // Set this to null, in case it was mutated during an aborted render.
        // 将其设置为null，以防它在中止的渲染过程中发生了变化。
        update.nextEffect = null;
        if (queue.lastEffect === null) {
          // 把副作用从 fiber queue 的 update 中分到 effect 中
          queue.firstEffect = queue.lastEffect = update;
        } else {
          queue.lastEffect.nextEffect = update;
          queue.lastEffect = update;
        }
      }
    }
    // Continue to the next update.
    update = update.next;
  }

  // Separately, iterate though the list of captured updates.
  // 单独地，迭代捕获的更新列表。
  let newFirstCapturedUpdate = null;
  update = queue.firstCapturedUpdate;
  while (update !== null) {
    const updateExpirationTime = update.expirationTime;
    if (updateExpirationTime < renderExpirationTime) {
      // This update does not have sufficient priority. Skip it.
      // 此更新没有足够的优先级。跳过它。
      if (newFirstCapturedUpdate === null) {
        // This is the first skipped captured update. It will be the first update in the new list.
        // 这是第一个跳过的捕获更新。这将是新列表中的第一次更新。
        newFirstCapturedUpdate = update;
        // If this is the first update that was skipped, the current result is the new base state.
        // 如果这是跳过的第一个更新，因此当前结果是新的基本 state 。
        if (newFirstUpdate === null) {
          newBaseState = resultState;
        }
      }
      // Since this update will remain in the list, update the remaining expiration time.
      // 由于此更新将保留在列表中，因此请更新剩余的过期时间。
      if (newExpirationTime < updateExpirationTime) {
        newExpirationTime = updateExpirationTime;
      }
    } else {
      // This update does have sufficient priority. Process it and compute a new result.
      // 此更新确实具有足够的优先级。处理它并计算新结果。
      resultState = getStateFromUpdate(
        workInProgress,
        queue,
        update,
        resultState,
        props,
        instance,
      );
      const callback = update.callback;
      if (callback !== null) {
        workInProgress.effectTag |= Callback;
        // Set this to null, in case it was mutated during an aborted render.
        // 将其设置为null，以防它在中止的渲染过程中发生了变化。
        update.nextEffect = null;
        if (queue.lastCapturedEffect === null) {
          queue.firstCapturedEffect = queue.lastCapturedEffect = update;
        } else {
          queue.lastCapturedEffect.nextEffect = update;
          queue.lastCapturedEffect = update;
        }
      }
    }
    update = update.next;
  }

  if (newFirstUpdate === null) {
    queue.lastUpdate = null;
  }
  if (newFirstCapturedUpdate === null) {
    queue.lastCapturedUpdate = null;
  } else {
    workInProgress.effectTag |= Callback;
  }
  if (newFirstUpdate === null && newFirstCapturedUpdate === null) {
    // We processed every update, without skipping.
    // That means the new base state is the same as the result state.
    // 我们处理了所有更新，没有跳过。
    // 这意味着新的基本 state 与结果 state 相同。
    newBaseState = resultState;
  }

  queue.baseState = newBaseState;
  queue.firstUpdate = newFirstUpdate;
  queue.firstCapturedUpdate = newFirstCapturedUpdate;

  // Set the remaining expiration time to be whatever is remaining in the queue.
  // 将剩余的过期时间设置为队列中剩余的时间。
  // This should be fine because the only two other things that contribute to expiration time are props and context.
  // 这应该没问题，因为影响到期时间的另外两件事是 props 和 context 。
  // We're already in the middle of the begin phase by the time we start processing the queue,
  // 当我们开始处理队列时，我们已经处于开始阶段的中间
  // so we've already dealt with the props. Context in components that specify shouldComponentUpdate is tricky;
  // 所以我们已经处理了 props 。指定shouldComponentUpdate的组件中的上下文很棘手。
  // but we'll have to account for that regardless.
  // 但无论如何，我们都必须考虑这一点。
  markUnprocessedUpdateTime(newExpirationTime);
  workInProgress.expirationTime = newExpirationTime;
  workInProgress.memoizedState = resultState;

  if (__DEV__) {
    currentlyProcessingQueue = null;
  }
}

function callCallback(callback, context) {
  invariant(
    typeof callback === 'function',
    'Invalid argument passed as callback. Expected a function. Instead ' +
      'received: %s',
    callback,
  );
  callback.call(context);
}

export function resetHasForceUpdateBeforeProcessing() {
  hasForceUpdate = false;
}

export function checkHasForceUpdateAfterProcessing(): boolean {
  return hasForceUpdate;
}

export function commitUpdateQueue<State>(
  finishedWork: Fiber,
  finishedQueue: UpdateQueue<State>,
  instance: any,
  renderExpirationTime: ExpirationTime,
): void {
  // If the finished render included captured updates, and there are still lower priority updates left over,
  // 如果完成的渲染包含捕获的更新，并且还剩下优先级较低的更新，
  // we need to keep the captured updates in the queue so that they are rebased and not dropped once we process the queue again at the lower priority.
  // 那么我们需要将捕获的更新保留在队列中，以便一旦我们以较低优先级再次处理队列时，捕获的更新将被重新设置并且不会被丢弃。
  if (finishedQueue.firstCapturedUpdate !== null) {
    // Join the captured update list to the end of the normal list.
    // 将捕获的更新列表加入到普通列表的末尾。
    if (finishedQueue.lastUpdate !== null) {
      finishedQueue.lastUpdate.next = finishedQueue.firstCapturedUpdate;
      finishedQueue.lastUpdate = finishedQueue.lastCapturedUpdate;
    }
    // Clear the list of captured updates.
    // 清除捕获的更新列表。
    finishedQueue.firstCapturedUpdate = finishedQueue.lastCapturedUpdate = null;
  }

  // Commit the effects
  commitUpdateEffects(finishedQueue.firstEffect, instance);
  finishedQueue.firstEffect = finishedQueue.lastEffect = null;

  commitUpdateEffects(finishedQueue.firstCapturedEffect, instance);
  finishedQueue.firstCapturedEffect = finishedQueue.lastCapturedEffect = null;
}

//taichiyi ReactDOM.render 的回调函数是通过这个触发的
function commitUpdateEffects<State>(
  effect: Update<State> | null,
  instance: any,
): void {
  while (effect !== null) {
    const callback = effect.callback;
    if (callback !== null) {
      effect.callback = null;
      callCallback(callback, instance);
    }
    effect = effect.nextEffect;
  }
}
