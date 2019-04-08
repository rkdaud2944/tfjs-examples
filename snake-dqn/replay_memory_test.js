/**
 * @license
 * Copyright 2019 Google LLC. All Rights Reserved.
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 * =============================================================================
 */

import {ReplayMemory} from "./replay_memory";

describe('ReplayMemory', () => {
  it('Not going over limit', () => {
    const memory = new ReplayMemory(10);
    expect(memory.length).toEqual(0);
    memory.append(10);
    memory.append(20);
    memory.append(30);
    expect(memory.length).toEqual(3);

    for (let i = 0; i < 10; ++i) {
      const batch = memory.sample(4);
      expect(batch.length).toEqual(4);
      batch.forEach(x => {
        expect([10, 20, 30].indexOf(x)).toBeGreaterThanOrEqual(0);
      });
    }
  });

  it('Going over limit', () => {
    const memory = new ReplayMemory(3);
    expect(memory.length).toEqual(0);
    memory.append(10);
    memory.append(20);
    memory.append(30);
    memory.append(40);
    expect(memory.length).toEqual(3);

    for (let i = 0; i < 10; ++i) {
      const batch = memory.sample(4);
      expect(batch.length).toEqual(4);
      console.log()
      batch.forEach(x => {
        expect([20, 30, 40].indexOf(x)).toBeGreaterThanOrEqual(0);
      });
    }
  });
});
