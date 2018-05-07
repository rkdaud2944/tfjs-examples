/**
 * @license
 * Copyright 2018 Google LLC. All Rights Reserved.
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

import {bindTensorFlowBackend} from '@tensorflow/tfjs-node';
import {PitchTypeModel} from '../pitch-type-model';
import {Socket} from './socket';
import {sleep} from '../utils';

const TIMEOUT_BETWEEN_EPOCHS_MS = 100;

// Enable TFJS-Node backend
bindTensorFlowBackend();

const pitchModel = new PitchTypeModel();
const socket = new Socket(pitchModel);

async function run() {
  socket.listen();
  await pitchModel.train(1, progress => socket.sendProgress(progress));
  socket.sendAccuracyPerClass(await pitchModel.evaluate());

  while (true) {
    await pitchModel.train(1, progress => socket.sendProgress(progress));
    socket.sendAccuracyPerClass(await pitchModel.evaluate());
    socket.broadcastUpdatedPredictions();
    await sleep(TIMEOUT_BETWEEN_EPOCHS_MS);
  }
}

run();