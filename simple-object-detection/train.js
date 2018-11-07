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

const canvas = require('canvas');
const tf = require('@tensorflow/tfjs');
const synthesizer = require('./synthetic_images');
const fetch = require('node-fetch');
require('@tensorflow/tfjs-node');

// For http/https model loading with tf.loadModel.
global.fetch = fetch;

// Name prefixes of layers that will be unfrozen during fine-tuning.
const topLayerGroupNames = ['conv_pw_10', 'conv_pw_11'];

// Name of the layer that will become the top layer of the truncated base.
const topLayerName =
    `${topLayerGroupNames[topLayerGroupNames.length - 1]}_relu`;

const classLossMultiplier = tf.scalar(500);

/**
 * Custom loss function for object detection.
 *
 * The loss function is a sum of two losses
 * - shape-class loss, computed as binaryCrossentropy and scaled by
 *   `classLossMultiplier` to match the scale of the bounding-box loss
 *   approximatey.
 * - bounding-box loss, computed as the meanSquaredError between the
 *   true and predicted bounding boxes.
 * @param {*} yTrue The true labels as a Tensor of shape [numExamples, 5]
 *   and dtype float32.
 *   The first column is assumed to be the 0-1 indicator for whether the
 *   object is a triangle (0) or a rectangle (1).
 *   The remaining columsn are assumed to be the bounding boxes (left, right,
 *   top, and bottom, in that order).
 * @param {*} yPred The predicted labels as a Tensor of the shape shape and
 *   dtype as `yTrue`. The assumed format of the tensor is the same as that of
 *   `yTrue` as well.
 */
function customLossFunction(yTrue, yPred) {
  return tf.tidy(() => {
    const batchSize = yTrue.shape[0];
    const boundingBoxDims = yTrue.shape[1] - 1;

    // Extract the shape-class portions of `yTrue` and `yPred`.
    const classTrue = yTrue.slice([0, 0], [batchSize, 1]);
    const classPred = tf.sigmoid(yPred.slice([0, 0], [batchSize, 1]));
    const classLoss =
        tf.metrics.binaryCrossentropy(classTrue, classPred).mean();

    // Extract the bounding-box portions of `yTrue` and `yPred`.
    const boundingBoxTrue = yTrue.slice([0, 1], [batchSize, boundingBoxDims]);
    const boundingBoxPred = yPred.slice([0, 1], [batchSize, boundingBoxDims]);
    const boundingBoxLoss =
        tf.metrics.meanSquaredError(boundingBoxTrue, boundingBoxPred);

    // Add the two losses to get the total loss. Note that `classLoss` is
    // scaled by a factor to match bounding-box loss in scale approximately.
    const totalLoss =
        classLoss.mulStrict(classLossMultiplier).add(boundingBoxLoss);
    return totalLoss;
  });
}

/**
 * Loads MobileNet and removes the top part.
 *
 * Also gets handles to the layers that will be unfrozen during the fine-tuning
 * phase of the training.
 */
async function loadTruncatedMobilenet() {
  const mobilenet = await tf.loadModel(
      'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_0.25_224/model.json');

  // Return a model that outputs an internal activation.
  const fineTuningLayers = [];
  const layer = mobilenet.getLayer(topLayerName);
  const truncatedBase =
      tf.model({inputs: mobilenet.inputs, outputs: layer.output});
  // Freeze the model's layers.
  for (const layer of truncatedBase.layers) {
    layer.trainable = false;
    for (const groupName of topLayerGroupNames) {
      if (layer.name.indexOf(groupName) === 0) {
        fineTuningLayers.push(layer);
        break;
      }
    }
  }

  tf.util.assert(
      fineTuningLayers.length > 1,
      `Did not find any layers that match the prefixes ${topLayerGroupNames}`);
  return {truncatedBase, fineTuningLayers};
}

/**
 * Build a new head (i.e., output sub-model) that will be connected to
 * the top of the truncated base for object detection.
 * 
 * @param {tf.Shape} inputShape Input shape of the new model.
 */
function buildNewHead(inputShape) {
  const newHead = tf.sequential();
  newHead.add(tf.layers.flatten({inputShape}));
  newHead.add(tf.layers.dense({units: 200, activation: 'relu'}));
  newHead.add(tf.layers.dense({units: 5, kernelInitializer}));
  return newHead;
}

/**
 * Builds object-detection model from MobileNet.
 */
async function buildObjectDetectionModel() {
  const {truncatedBase, fineTuningLayers} = await loadTruncatedMobilenet();

  // Build the new head model.
  const newHead = buildNewHead(truncatedBase.outputs[0].shape.slice(1));

  // Connect the new head model with the truncated base model.
  const newOutput = newHead.apply(truncatedBase.outputs[0]);

  // Construct the end-to-end model for object detection.
  const model = tf.model({inputs: truncatedBase.inputs, outputs: newOutput});

  return {model, fineTuningLayers};
}

(async function main() {
  const canvasSize = 224;  // Matches the input size of MobileNet.
  const numExamples = 10000;
  const validationSplit = 0.15;
  const numCircles = 10;
  const numLines = 10;

  const batchSize = 128;
  const initialTransferEpochs = 50;
  const fineTuningEpochs = 100;
  const modelSaveURL = 'file://./dist/object_detection_model';

  console.log(`Generating ${numExamples} training examples...`);
  const synthDataCanvas = canvas.createCanvas(canvasSize, canvasSize);
  const synth =
      new synthesizer.ObjectDetectionImageSynthesizer(synthDataCanvas, tf);
  const {images, targets} =
      await synth.generateExampleBatch(numExamples, numCircles, numLines);

  const {model, fineTuningLayers} = await buildObjectDetectionModel();
  model.compile({loss: customLossFunction, optimizer: 'rmsprop'});
  model.summary();

  // Initial phase of transfer learning.
  await model.fit(images, targets, {
    epochs: initialTransferEpochs,
    batchSize,
    validationSplit,
  });

  // Fine-tuning phase of transfer learning.
  // Unfreeze layers for fine-tuning.
  for (const layer of fineTuningLayers) {
    layer.trainable = true;
  }
  model.compile({loss: customLossFunction, optimizer: 'rmsprop'});
  model.summary();

  // Do fine-tuning.
  await model.fit(images, targets, {
    epochs: fineTuningEpochs,
    batchSize: batchSize / 2,
    validationSplit,
  });

  // Save model.
  await model.save(modelSaveURL);
  console.log(`Trained model is saved to ${modelSaveURL}`);
  console.log(
      `\nNext, run the following command to test the model in the browser:`);
  console.log(`yarn watch`);
})();
