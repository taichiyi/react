/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

//taichiyi 副作用类型
//taichiyi workInProgress 的 fiber 的 SideEffectTag 是在渲染阶段确定的。
//taichiyi 在提交阶段，通过 workInProgress 的 fiber 通过 SideEffectTag 判断如果更新到对应的 current 上。
export type SideEffectTag = number;

// Don't change these two values. They're used by React Dev Tools.
// 不要更改这两个值。它们被React Dev Tools使用。
export const NoEffect = /*              */ 0b0000000000000;
export const PerformedWork = /*         */ 0b0000000000001;

// You can change the rest (and add more).
export const Placement = /*             */ 0b0000000000010;
export const Update = /*                */ 0b0000000000100;
export const PlacementAndUpdate = /*    */ 0b0000000000110;
export const Deletion = /*              */ 0b0000000001000;
export const ContentReset = /*          */ 0b0000000010000;
export const Callback = /*              */ 0b0000000100000;
export const DidCapture = /*            */ 0b0000001000000;
export const Ref = /*                   */ 0b0000010000000;
export const Snapshot = /*              */ 0b0000100000000;
export const Passive = /*               */ 0b0001000000000;
export const Hydrating = /*             */ 0b0010000000000;
export const HydratingAndUpdate = /*    */ 0b0010000000100;

// Passive & Update & Callback & Ref & Snapshot
export const LifecycleEffectMask = /*   */ 0b0001110100100;

// Union of all host effects
export const HostEffectMask = /*        */ 0b0011111111111;

export const Incomplete = /*            */ 0b0100000000000;
export const ShouldCapture = /*         */ 0b1000000000000;
