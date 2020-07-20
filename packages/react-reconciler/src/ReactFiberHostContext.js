/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Fiber} from './ReactFiber';
import type {StackCursor} from './ReactFiberStack';
import type {Container, HostContext} from './ReactFiberHostConfig';

import invariant from 'shared/invariant';

import {getChildHostContext, getRootHostContext} from './ReactFiberHostConfig';
import {createCursor, push, pop} from './ReactFiberStack';

declare class NoContextT {}
const NO_CONTEXT: NoContextT = ({}: any);

let contextStackCursor: StackCursor<HostContext | NoContextT> = createCursor(
  NO_CONTEXT,
);
let contextFiberStackCursor: StackCursor<Fiber | NoContextT> = createCursor(
  NO_CONTEXT,
);
let rootInstanceStackCursor: StackCursor<Container | NoContextT> = createCursor(
  NO_CONTEXT,
);

function requiredContext<Value>(c: Value | NoContextT): Value {
  invariant(
    c !== NO_CONTEXT,
    'Expected host context to exist. This error is likely caused by a bug ' +
      'in React. Please file an issue.',
  );
  return (c: any);
}

function getRootHostContainer(): Container {
  const rootInstance = requiredContext(rootInstanceStackCursor.current);
  return rootInstance;
}

function pushHostContainer(fiber: Fiber, nextRootInstance: Container) {
  // Push current root instance onto the stack;
  // 将当前的根实例推入栈；
  // This allows us to reset root when portals are popped.
  // 这允许我们在弹出门户时重置根目录。
  push(rootInstanceStackCursor, nextRootInstance, fiber);
  // Track the context and the Fiber that provided it.
  // 跟踪上下文和提供上下文的光纤。
  // This enables us to pop only Fibers that provide unique contexts.
  // 这使我们能够仅弹出提供独特上下文的光纤。
  push(contextFiberStackCursor, fiber, fiber);

  // Finally, we need to push the host context to the stack.
  // 最后，我们需要将主机上下文推送到栈。
  // However, we can't just call getRootHostContext() and push it because we'd have a different number of entries on the stack depending on whether getRootHostContext() throws somewhere in renderer code or not.
  // 但是，我们不能只调用getRootHostContext（）并推送它，因为根据getRootHostContext（）是否在渲染器代码中抛出某个地方，栈中的条目数会有所不同。
  // So we push an empty value first. This lets us safely unwind on errors.
  // 因此，我们首先推送一个空值。 这使我们可以安全地消除错误。
  push(contextStackCursor, NO_CONTEXT, fiber);
  const nextRootContext = getRootHostContext(nextRootInstance);
  // Now that we know this function doesn't throw, replace it.
  // 现在我们知道该函数不会抛出，请替换它。
  pop(contextStackCursor, fiber);
  push(contextStackCursor, nextRootContext, fiber);
}

function popHostContainer(fiber: Fiber) {
  pop(contextStackCursor, fiber);
  pop(contextFiberStackCursor, fiber);
  pop(rootInstanceStackCursor, fiber);
}

function getHostContext(): HostContext {
  const context = requiredContext(contextStackCursor.current);
  return context;
}

function pushHostContext(fiber: Fiber): void {
  const rootInstance: Container = requiredContext(
    rootInstanceStackCursor.current,
  );
  const context: HostContext = requiredContext(contextStackCursor.current);
  const nextContext = getChildHostContext(context, fiber.type, rootInstance);

  // Don't push this Fiber's context unless it's unique.
  if (context === nextContext) {
    return;
  }

  // Track the context and the Fiber that provided it.
  // This enables us to pop only Fibers that provide unique contexts.
  push(contextFiberStackCursor, fiber, fiber);
  push(contextStackCursor, nextContext, fiber);
}

function popHostContext(fiber: Fiber): void {
  // Do not pop unless this Fiber provided the current context.
  // pushHostContext() only pushes Fibers that provide unique contexts.
  if (contextFiberStackCursor.current !== fiber) {
    return;
  }

  pop(contextStackCursor, fiber);
  pop(contextFiberStackCursor, fiber);
}

export {
  getHostContext,
  getRootHostContainer,
  popHostContainer,
  popHostContext,
  pushHostContainer,
  pushHostContext,
};
