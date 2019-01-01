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

/**
 * Based on
 * https://github.com/fchollet/deep-learning-with-python-notebooks/blob/master/5.4-visualizing-what-convnets-learn.ipynb
 */

const argparse = require('argparse');
const fs = require('fs');
const path = require('path');
const shelljs = require('shelljs');
const tf = require('@tensorflow/tfjs');
const utils = require('./utils');

// TODO(cais): Clean up.
// const MODEL_PATH =
//     // tslint:disable-next-line:max-line-length
//     'https://storage.googleapis.com/tfjs-models/tfjs/mobilenet_v1_0.25_224/model.json';
// const MODEL_PATH = 'https://storage.googleapis.com/tfjs-speech-model-test/mobilenetv2_tfjs/model.json';
// const MODEL_PATH = 'https://storage.googleapis.com/tfjs-speech-model-test/mobilenetv2_0.35_tfjs/model.json';
// const MODEL_PATH = 'https://storage.googleapis.com/tfjs-models/tfjs/mnist_transfer_cnn_v1/model.json';
// const MODEL_PATH = 'file://./vgg16_tfjs/model.json';

const EPSILON = 1e-5;  // "Fudge" factor to prevent division by zero.

// const filterCanvas = document.getElementById('filter');

// TODO(cais): Deduplicate with index.js.
// TODO(cais): Get rid of filterIndex.
// TODO(cais): Doc string.
/**
 * Generate the maximally-activating input image for a conv2d layer filter.
 * 
 * Uses gradient ascent in input space.
 * 
 * @param {tf.Model} model The model that the conv2d layer of interest belongs
 *   to.
 * @param {string} layerName Name of the layer.
 * @param {number} filterIndex Index to the filter of interest. Must be
 *   < number of filters of the conv2d layer.
 * @param {number} iterations Number of gradient-ascent iterations.
 * @return {tf.Tensor} The maximally-activating input image as a tensor.
 */
function inputGradientAscent(model, layerName, filterIndex, iterations = 40) {
  return tf.tidy(() => {
    const imageH = model.inputs[0].shape[1];
    const imageW = model.inputs[0].shape[2];
    const imageDepth = model.inputs[0].shape[3];

    const layerOutput = model.getLayer(layerName).output;
    const auxModel = tf.model({inputs: model.inputs, outputs: layerOutput});
    const lossFunction =
        (input) => auxModel.apply(input, {training: true}).gather([filterIndex], 3);
  
    let image = tf.randomUniform([1, imageH, imageW, imageDepth], 0, 1).mul(20).add(128);
    const gradients = tf.grad(lossFunction);

    const stepSize = 1;
    for (let i = 0; i < iterations; ++i) {
      // console.log(`Iteration ${i + 1}/${iterations}`);  // DEBUG
      const scaledGrads = tf.tidy(() => {
        const grads = gradients(image);
        const norm = tf.sqrt(tf.mean(tf.square(grads))).add(EPSILON);
        return grads.div(norm);
      });
      const newInputImage = image.add(scaledGrads.mul(stepSize));
      scaledGrads.dispose();
      image.dispose();
      image = newInputImage;
    }
    return deprocessImage(image);
  });
}

function deprocessImage(x) {
  return tf.tidy(() => {
    const {mean, variance} = tf.moments(x);
    x = x.sub(mean);
    x = x.div(tf.sqrt(variance).add(EPSILON));
    // Clip to [0, 1].
    x = x.add(0.5);
    x = tf.clipByValue(x, 0, 1);
    x = x.mul(255);
    return tf.clipByValue(x, 0, 255).asType('int32');
  });
}

/**
 * Visualize the maximally-activating input images for a covn2d layer.
 * 
 * @param {tf.Model} model The model that the conv2d layer of interest belongs
 *   to.
 * @param {string} layerName The name of the layer of interest.
 * @param {number} numFilters Number of the conv2d layer's filter to calculate
 *   maximally-activating inputs for. If this exceeds the number of filters
 *   that the conv2d layer has, it will be cut off.
 * @param {string} filePathPrefix File path prefix to which the output image
 *   will be written.
 * @returns {string[]} Paths to the image files generated in this call.
 */
function writeConvLayerFilters(model, layerName, numFilters, iterations, filePathPrefix) {
  const filePaths = [];
  tf.tidy(() => {
    const maxFilters = model.getLayer(layerName).getWeights()[0].shape[3];
    if (numFilters > maxFilters) {
      numFilters = maxFilters;
    }
    for (let i = 0; i < numFilters; ++i) {
      console.log(`Processing layer ${layerName}, filter ${i + 1} of ${numFilters}`);
      const imageTensor = inputGradientAscent(model, layerName, i, iterations);
      const outputFilePath = `${filePathPrefix}_${layerName}_${i}.png`;
      filePaths.push(outputFilePath);
      utils.writeImageTensorToFile(imageTensor, outputFilePath);
      console.log(`  --> ${outputFilePath}`);
    }
  });
  return filePaths;
}

function parseArguments() {
  const parser = new argparse.ArgumentParser({
    description: 'Visualize convnet'
  });
  parser.addArgument('modelJsonUrl', {
    type: 'string',
    help: 'URL to model JSON. Can be a file://, http://, or https:// URL'
  });
  parser.addArgument('convLayerNames', {
    type: 'string',
    help: 'Names of the conv2d layers to visualize, separated by commas ' +
    'e.g., (block1_conv1,block2_conv1,block3_conv1,block4_conv1)'
  });
  parser.addArgument('--outputPathPrefix', {
    type: 'string',
    defaultValue: 'dist/filters/filter',
    help: 'Output file path prefix'
  });
  parser.addArgument('--filters', {
    type: 'int',
    defaultValue: 64,
    help: 'Number of filters to visualize for each conv2d layer'
  });
  parser.addArgument('--iterations', {
    type: 'int',
    defaultValue: 40,
    help: 'Number of iterations to use for gradient ascent'
  });
  parser.addArgument('--gpu', {
    action: 'storeTrue',
    help: 'Use tfjs-node-gpu (required CUDA GPU).'
  });
  return parser.parseArgs();
}

async function run() {
  const args = parseArguments();
  console.log('args:', args);  // DEBUG

  if (args.gpu) {
    // Use GPU bindings.
    require('@tensorflow/tfjs-node-gpu');
  } else {
    // Use CPU bindings.
    require('@tensorflow/tfjs-node');
  }

  console.log('Loading model...');
  if (args.modelJsonUrl.indexOf('http://') === -1 &&
      args.modelJsonUrl.indexOf('https://') === -1 &&
      args.modelJsonUrl.indexOf('file://') === -1) {
    args.modelJsonUrl = `file://${args.modelJsonUrl}`;
  }
  const model = await tf.loadModel(args.modelJsonUrl);
  // const model = await tf.loadModel('./vgg16_tfjs/model.json');
  // model.summary();  //

  // Warmup the model. This isn't necessary, but makes the first prediction
  // faster. Call `dispose` to release the WebGL memory allocated for the return
  // value of `predict`.
  // model.predict(tf.zeros([1, IMAGE_SIZE, IMAGE_SIZE, 3])).dispose();

  console.log('Calling generate patterns');  // DEBUG
  // generatePatterns(model, 'conv_pw_8', 0);
  // generatePatterns(model, 'conv_pw_8_relu', 10);
  // generatePatterns(model, 'conv_pw_9_relu', 11);
  // generatePatterns(model, 'conv_pw_14', 0);
  // generatePatterns(model, 'block_1_depthwise', 3);

  // MobileNetV2 alpha=1.0.
//   generatePatterns(model, 'block_1_depthwise_relu', 50);  // Interesting.
  // generatePatterns(model, 'block_2_depthwise_relu', 2);  // Interesting.
  // generatePatterns(model, 'block_3_depthwise_relu', 0);  // Interesting.
  // generatePatterns(model, 'block_4_depthwise_relu', 100);  // Interesting.
  // generatePatterns(model, 'block_4_depthwise_relu', 128);  // Interesting.
  // Becomes extremely slow when you reach block 5.
//   generatePatterns(model, 'block_5_depthwise_relu', 1);  // Interesting.

  // MobileNetV2 alpha=0.35.
  // generatePatterns(model, 'block_1_depthwise_relu', 0);  // Interesting.
  // generatePatterns(model, 'block_1_depthwise_relu', 7);  // Interesting.
  // generatePatterns(model, 'block_5_depthwise_relu', 1);  // Interesting.
  // generatePatterns(model, 'block_6_depthwise_relu', 2);  // Interesting.
  // generatePatterns(model, 'block_8_depthwise_relu', 2);  // Interesting.
  // generatePatterns(model, 'block_10_depthwise_relu', 100);  // Interesting.
  // generatePatterns(model, 'block_12_depthwise_relu', 100);  // Interesting.
  
  // MNIST model.
//   generatePatterns(model, 'max_pooling2d_1', 1);  // Interesting.

  console.log(args.outputPathPrefix);  // DEBUG
  const outputDirname = path.dirname(args.outputPathPrefix);
  if (!fs.existsSync(outputDirname)) {
    shelljs.mkdir('-p', outputDirname);
  }

  // VGG16
  // TODO(cais): Handle multiple layers.
  // inputGradientAscent(model, args.convLayerNames, filterIndex, args.iterations);  // Interesting.
  writeConvLayerFilters(model, args.convLayerNames, args.filters, args.iterations, args.outputPathPrefix);

  // TODO(cais): 
};

run();
