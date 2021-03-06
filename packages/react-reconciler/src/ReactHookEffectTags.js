/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

export type HookEffectTag = number;

export const NoEffect = /*             */ 0b00000000; // 0
export const UnmountSnapshot = /*      */ 0b00000010; // 2
export const UnmountMutation = /*      */ 0b00000100; // 4
export const MountMutation = /*        */ 0b00001000; // 8
export const UnmountLayout = /*        */ 0b00010000; // 16
export const MountLayout = /*          */ 0b00100000; // 32
export const MountPassive = /*         */ 0b01000000; // 64
export const UnmountPassive = /*       */ 0b10000000; // 128
