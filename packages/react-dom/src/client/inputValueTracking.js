/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

type ValueTracker = {
  getValue(): string,
  setValue(value: string): void,
  stopTracking(): void,
};
type WrapperState = {_valueTracker?: ?ValueTracker};
type ElementWithValueTracker = HTMLInputElement & WrapperState;

function isCheckable(elem: HTMLInputElement) {
  const type = elem.type;
  const nodeName = elem.nodeName;
  return (
    nodeName &&
    nodeName.toLowerCase() === 'input' &&
    (type === 'checkbox' || type === 'radio')
  );
}

function getTracker(node: ElementWithValueTracker) {
  return node._valueTracker;
}

function detachTracker(node: ElementWithValueTracker) {
  node._valueTracker = null;
}

function getValueFromNode(node: HTMLInputElement): string {
  let value = '';
  if (!node) {
    return value;
  }

  if (isCheckable(node)) {
    value = node.checked ? 'true' : 'false';
  } else {
    value = node.value;
  }

  return value;
}

function trackValueOnNode(node: any): ?ValueTracker {
  const valueField = isCheckable(node) ? 'checked' : 'value';
  const descriptor = /* ✨ */Object.getOwnPropertyDescriptor(
    node.constructor.prototype,
    valueField,
  );

  let currentValue = '' + node[valueField];

  // if someone has already defined a value or Safari, then bail and don't track value will cause over reporting of changes, but it's better then a hard failure (needed for certain tests that spyOn input values and Safari)
  if (
    // 如果有人已经定义了一个值或Safari，则保释并且不跟踪值会导致对更改的过度报告，但总比硬失败更好（某些监视输入值和Safari的测试需要）
    node.hasOwnProperty(valueField) ||
    typeof descriptor === 'undefined' ||
    typeof descriptor.get !== 'function' ||
    typeof descriptor.set !== 'function'
  ) {
    return;
  }
  const {get, set} = descriptor;
  Object.defineProperty(node, valueField, {
    configurable: true,
    get: function() {
      return get.call(this);
    },
    set: function(value) {
      currentValue = '' + value;
      set.call(this, value);
    },
  });
  // We could've passed this the first time but it triggers a bug in IE11 and Edge 14/15.
  // 我们本来可以通过的，但它会触发IE11和Edge 14/15中的错误。
  // Calling defineProperty() again should be equivalent.
  // 再次调用defineProperty（）应该等效。
  // https://github.com/facebook/react/issues/11768
  Object.defineProperty(node, valueField, {
    enumerable: descriptor.enumerable,
  });

  const tracker = {
    getValue() {
      return currentValue;
    },
    setValue(value) {
      currentValue = '' + value;
    },
    stopTracking() {
      detachTracker(node);
      delete node[valueField];
    },
  };
  return tracker;
}

export function track(node: ElementWithValueTracker) {
  if (getTracker(node)) {
    return;
  }

  // TODO: Once it's just Fiber we can move this to node._wrapperState
  node._valueTracker = trackValueOnNode(node);
}

export function updateValueIfChanged(node: ElementWithValueTracker) {
  if (!node) {
    return false;
  }

  const tracker = getTracker(node);
  // if there is no tracker at this point it's unlikely
  // that trying again will succeed
  if (!tracker) {
    return true;
  }

  const lastValue = tracker.getValue();
  const nextValue = getValueFromNode(node);
  if (nextValue !== lastValue) {
    tracker.setValue(nextValue);
    return true;
  }
  return false;
}

export function stopTracking(node: ElementWithValueTracker) {
  const tracker = getTracker(node);
  if (tracker) {
    tracker.stopTracking();
  }
}
