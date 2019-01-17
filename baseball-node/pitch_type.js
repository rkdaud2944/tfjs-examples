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

const tf = require('@tensorflow/tfjs');
const normalize = require('./utils').normalize;

const TRAIN_DATA_PATH =
    'https://storage.googleapis.com/mlb-pitch-data/pitch_type_training_data.csv';
const TEST_DATA_PATH =
    'https://storage.googleapis.com/mlb-pitch-data/pitch_type_test_data.csv';

// Constants from training data:
const VX0_MIN = -18.885;
const VX0_MAX = 18.065;
const VY0_MIN = -152.463;
const VY0_MAX = -86.374;
const VZ0_MIN = -15.5146078412997;
const VZ0_MAX = 9.974;
const AX_MIN = -48.0287647107959;
const AX_MAX = 30.592;
const AY_MIN = 9.397;
const AY_MAX = 49.18;
const AZ_MIN = -49.339;
const AZ_MAX = 2.95522851438373;
const START_SPEED_MIN = 59;
const START_SPEED_MAX = 104.4;

const NUM_PITCH_CLASSES = 7;
const TRAINING_DATA_LENGTH = 7000;
const TEST_DATA_LENGTH = 700;

// Converts a row from the CSV into features and labels.
// Each feature field is normalized within training data constants:
const csvTransform = ([features, labels]) => {
  const values = [
    normalize(features.vx0, VX0_MIN, VX0_MAX),
    normalize(features.vy0, VY0_MIN, VY0_MAX),
    normalize(features.vz0, VZ0_MIN, VZ0_MAX),
    normalize(features.ax, AX_MIN, AX_MAX),
    normalize(features.ay, AY_MIN, AY_MAX),
    normalize(features.az, AZ_MIN, AZ_MAX),
    normalize(features.start_speed, START_SPEED_MIN, START_SPEED_MAX),
    features.left_handed_pitcher
  ];
  return [values, [labels.pitch_code]];
};

const trainingData =
    tf.data.csv(TRAIN_DATA_PATH, {columnConfigs: {pitch_code: {isLabel: true}}})
        .map(csvTransform)
        .shuffle(TRAINING_DATA_LENGTH)
        .batch(100);

const testData =
    tf.data.csv(TEST_DATA_PATH, {columnConfigs: {pitch_code: {isLabel: true}}})
        .map(csvTransform)
        .shuffle(TEST_DATA_LENGTH)
        .batch(100);

// Load all training data in one batch to use for eval:
const trainingValidationData =
    tf.data.csv(TRAIN_DATA_PATH, {columnConfigs: {pitch_code: {isLabel: true}}})
        .map(csvTransform)
        .batch(TRAINING_DATA_LENGTH);

// Load all test data in one batch to use for eval:
const testDataValidationData =
    tf.data.csv(TEST_DATA_PATH, {columnConfigs: {pitch_code: {isLabel: true}}})
        .map(csvTransform)
        .batch(TEST_DATA_LENGTH);

const model = tf.sequential();
model.add(tf.layers.dense({units: 250, activation: 'relu', inputShape: [8]}));
model.add(tf.layers.dense({units: 175, activation: 'relu'}));
model.add(tf.layers.dense({units: 150, activation: 'relu'}));
model.add(tf.layers.dense({units: NUM_PITCH_CLASSES, activation: 'softmax'}));
model.compile({
  optimizer: tf.train.adam(),
  loss: 'sparseCategoricalCrossentropy',
  metrics: ['accuracy']
});

// Returns pitch class evaluation percentages for training data with an option
// to include test data.
async function evaluate(useTestData) {
  let results = {};

  // TODO(kreger): Refactor and clean this up:
  await trainingValidationData.forEach((pitchTypeBatch) => {
    const values = model.predict(pitchTypeBatch[0]).dataSync();
    const classSize = TRAINING_DATA_LENGTH / NUM_PITCH_CLASSES;

    for (let i = 0; i < NUM_PITCH_CLASSES; i++) {
      // Output has 7 different class values for each pitch, offset based on
      // which pitch class (ordered by i):
      let index = (i * classSize * NUM_PITCH_CLASSES) + i;
      let total = 0;
      for (let j = 0; j < classSize; j++) {
        total += values[index];
        index += NUM_PITCH_CLASSES;
      }

      results[pitchFromClassNum(i)] = {training: total / classSize};
    }
  });

  if (useTestData) {
    await testDataValidationData.forEach((pitchTypeBatch) => {
      const values = model.predict(pitchTypeBatch[0]).dataSync();
      const classSize = TEST_DATA_LENGTH / NUM_PITCH_CLASSES;
      const labels = pitchTypeBatch[1].dataSync();

      for (let i = 0; i < NUM_PITCH_CLASSES; i++) {
        // Output has 7 different class values for each pitch, offset based on
        // which pitch class (ordered by i):
        let index = (i * classSize * NUM_PITCH_CLASSES) + i;
        let total = 0;
        const test = labels[index];
        for (let j = 0; j < classSize; j++) {
          total += values[index];
          index += NUM_PITCH_CLASSES;
        }

        results[pitchFromClassNum(i)].validation = total / classSize;
      }
    });
  }
  return results;
}

// Returns the string value for Baseball pitch labels
function pitchFromClassNum(classNum) {
  switch (classNum) {
    case 0:
      return 'Fastball (2-seam)';
    case 1:
      return 'Fastball (4-seam)';
    case 2:
      return 'Fastball (sinker)';
    case 3:
      return 'Fastball (cutter)';
    case 4:
      return 'Slider';
    case 5:
      return 'Changeup';
    case 6:
      return 'Curveball';
    default:
      return 'Unknown';
  }
}

module.exports = {
  evaluate,
  model,
  pitchFromClassNum,
  testData,
  trainingData
}
