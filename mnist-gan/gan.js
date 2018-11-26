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
 * Train an Auxiliary Classifier Generative Adversarial Network (ACGAN) on the
 * MNIST dataset.
 *
 * For background of ACGAN, see
 * - Augustus Odena, Christopher Olah, Jonathon Shlens (2017) "Conditional
 *   image synthesis with auxiliary classifier GANs"
 *   https://arxiv.org/abs/1610.09585
 *
 * You should use tfjs-node-gpu to train the model on a GPU, as the convolution
 * -heavy operations run much more slowly on a CPU.
 */

const fs = require('fs');
const path = require('path');

const argparse = require('argparse');
const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-node-gpu');

const data = require('./data');

// Number of classes in the MNIST dataset.
const NUM_CLASSES = 10;
// MNIST image size.
const IMAGE_SIZE = 28;

/**
 * Build the generator part of ACGAN.
 *
 * The generator of ACGAN takes two inputs:
 *
 *   1. A random latent-space vector (the latent space is often referred to
 *      as "z-space" in GAN literature).
 *   2. A label for the desired image category (0, 1, ..., 9).
 *
 * It generates one output: the generated (i.e., fake) image.
 *
 * @param {number} latentSize Size of the latent space.
 * @returns {tf.Model} The generator model.
 */
function buildGenerator(latentSize) {
  tf.util.assert(
      latentSize > 0 && Number.isInteger(latentSize),
      `Expected latent-space size to be a positive integer, but ` +
          `got ${latentSize}.`);

  const cnn = tf.sequential();

  cnn.add(tf.layers.dense(
      {units: 3 * 3 * 384, inputShape: [latentSize], activation: 'relu'}));
  cnn.add(tf.layers.reshape({targetShape: [3, 3, 384]}));

  // Upsample from [3, 3, ...] to [7, 7, ...].
  cnn.add(tf.layers.conv2dTranspose({
    filters: 192,
    kernelSize: 5,
    strides: 1,
    padding: 'valid',
    activation: 'relu',
    kernelInitializer: 'glorotNormal'
  }));
  cnn.add(tf.layers.batchNormalization());

  // Upsample to [14, 14, ...].
  cnn.add(tf.layers.conv2dTranspose({
    filters: 96,
    kernelSize: 5,
    strides: 2,
    padding: 'same',
    activation: 'relu',
    kernelInitializer: 'glorotNormal'
  }));
  cnn.add(tf.layers.batchNormalization());

  // Upsample to [28, 28, ...].
  cnn.add(tf.layers.conv2dTranspose({
    filters: 1,
    kernelSize: 5,
    strides: 2,
    padding: 'same',
    activation: 'tanh',
    kernelInitializer: 'glorotNormal'
  }));

  // This is the z space commonly referred to in GAN papers.
  const latent = tf.input({shape: [latentSize]});

  // The desired label of the generated image, an integer in the interval
  // [0, NUM_CLASSES).
  const imageClass = tf.input({shape: [1]});

  // The desired label is converted to a vector of length `latentSize`
  // through embedding lookup.
  const cls = tf.layers
                  .embedding({
                    inputDim: NUM_CLASSES,
                    outputDim: latentSize,
                    embeddingsInitializer: 'glorotNormal'
                  })
                  .apply(imageClass);

  // Hadamard product between z-space and a class conditional embedding.
  const h = tf.layers.multiply().apply([latent, cls]);

  const fakeImage = cnn.apply(h);
  return tf.model({inputs: [latent, imageClass], outputs: fakeImage});
}

/**
 * Build the discriminator part of ACGAN.
 *
 * The discriminator model of ACGAN takes the input: an image of
 * MNIST format, of shape [batchSize, 28, 28, 1].
 *
 * It gives two outputs:
 *
 *   1. A sigmoid probability score between 0 and 1, for whether the
 *      discriminator judges the input image to be real (close to 1)
 *      or fake (closer to 0).
 *   2. Softmax probability scores for the 10 MNIST digit categories,
 *      which is the discriminator's 10-class classification result
 *      for the input image.
 *
 * @returns {tf.Model} The discriminator model.
 */
function buildDiscriminator() {
  const cnn = tf.sequential();

  cnn.add(tf.layers.conv2d({
    filters: 32,
    kernelSize: 3,
    padding: 'same',
    strides: 2,
    inputShape: [IMAGE_SIZE, IMAGE_SIZE, 1]
  }));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.conv2d(
      {filters: 64, kernelSize: 3, padding: 'same', strides: 1}));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.conv2d(
      {filters: 128, kernelSize: 3, padding: 'same', strides: 2}));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.conv2d(
      {filters: 256, kernelSize: 3, padding: 'same', strides: 1}));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.flatten());

  const image = tf.input({shape: [IMAGE_SIZE, IMAGE_SIZE, 1]});
  const features = cnn.apply(image);

  const fake =
      tf.layers.dense({units: 1, activation: 'sigmoid'}).apply(features);
  const aux = tf.layers.dense({units: NUM_CLASSES, activation: 'softmax'})
                  .apply(features);

  return tf.model({inputs: image, outputs: [fake, aux]});
}

async function run() {
  const parser = new argparse.ArgumentParser({
    description: 'TensorFlowj.js: MNIST ACGAN trainer example.',
    addHelp: true
  });
  parser.addArgument(
      '--epochs',
      {type: 'int', defaultValue: 100, help: 'Number of training epochs.'});
  parser.addArgument('--batchSize', {
    type: 'int',
    defaultValue: 100,
    help: 'Batch size to be used during training.'
  });
  parser.addArgument('--latentSize', {
    type: 'int',
    defaultValue: 100,
    help: 'Size of the latent space (z-space).'
  });
  parser.addArgument('--generatorSavePath', {
    type: 'string',
    defaultValue: './dist/generator',
    help: 'Path to which the generator model will be saved after every epoch.'
  });
  const args = parser.parseArgs();

  const learningRate = 0.0002;
  const adamBeta1 = 0.5;

  if (!fs.existsSync(path.dirname(args.generatorSavePath))) {
    fs.mkdirSync(path.dirname(args.generatorSavePath));
  }
  const saveURL = `file://${args.generatorSavePath}`;

  // Build the discriminator.
  const discriminator = buildDiscriminator();
  discriminator.compile({
    optimizer: tf.train.adam(learningRate, adamBeta1),
    loss: ['binaryCrossentropy', 'sparseCategoricalCrossentropy']
  });
  discriminator.summary();

  // Build the generator.
  const generator = buildGenerator(args.latentSize);
  generator.summary();

  const latent = tf.input({shape: [args.latentSize]});
  const imageClass = tf.input({shape: [1]});

  // Get a fake image.
  let fake = generator.apply([latent, imageClass]);
  let aux;

  // We only want to be able to train generation for the combined model.
  discriminator.trainable = false;
  [fake, aux] = discriminator.apply(fake);
  const combined =
      tf.model({inputs: [latent, imageClass], outputs: [fake, aux]});
  combined.compile({
    optimizer: tf.train.adam(learningRate, adamBeta1),
    loss: ['binaryCrossentropy', 'sparseCategoricalCrossentropy']
  });
  combined.summary();

  await data.loadData();
  let {images: xTrain, labels: yTrain} = data.getTrainData();
  yTrain = tf.expandDims(yTrain.argMax(-1), -1);

  const softOne = tf.scalar(0.95);
  for (let epoch = 0; epoch < args.epochs; ++epoch) {
    const tBatchBegin = tf.util.now();

    const numBatches = Math.ceil(xTrain.shape[0] / args.batchSize);

    for (let batch = 0; batch < numBatches; ++batch) {
      const actualBatchSize = (batch + 1) * args.batchSize >= xTrain.shape[0] ?
          (xTrain.shape[0] - batch * args.batchSize) :
          args.batchSize;
      const imageBatch = xTrain.slice(batch * args.batchSize, actualBatchSize);
      const labelBatch = yTrain.slice(batch * args.batchSize, actualBatchSize)
                             .asType('float32');

      let noise = tf.randomUniform([actualBatchSize, args.latentSize], -1, 1);
      let sampledLabels =
          tf.randomUniform([actualBatchSize, 1], 0, NUM_CLASSES, 'int32')
              .asType('float32');

      const generatedImages = generator.predict([noise, sampledLabels]);

      const x = tf.concat([imageBatch, generatedImages], 0);
      tf.dispose([imageBatch, generatedImages]);
      const y = tf.tidy(() => tf.concat([
        tf.ones([actualBatchSize, 1]).mul(softOne),
        tf.zeros([actualBatchSize, 1])
      ]));

      const auxY = tf.concat([labelBatch, sampledLabels], 0);

      const dLoss = await discriminator.trainOnBatch(x, [y, auxY]);
      tf.dispose([x, y, auxY]);

      // Make new noise. We generate 2 * actualBatchSize here, so that we have
      // the generator optimizer over an identical number of images
      // as the discriminator.
      tf.dispose([noise, sampledLabels]);
      noise = tf.randomUniform([2 * actualBatchSize, args.latentSize], -1, 1);
      sampledLabels =
          tf.randomUniform([2 * actualBatchSize, 1], 0, NUM_CLASSES, 'int32')
              .asType('float32');

      // We want to train the generator to trick the discriminator.
      // For the generator, we want all the {fake, not-fake} labels to say
      // not-fake.
      const trick =
          tf.tidy(() => tf.ones([2 * actualBatchSize, 1]).mul(softOne));

      const gLoss = await combined.trainOnBatch(
          [noise, sampledLabels], [trick, sampledLabels]);
      console.log(
          `epoch ${epoch + 1}/${args.epochs} batch ${batch + 1}/${
              numBatches}: ` +
          `dLoss = ${dLoss[0].get().toFixed(6)}, ` +
          `gLoss = ${gLoss[0].get().toFixed(6)}`);
      tf.dispose([noise, trick, dLoss, gLoss]);
    }

    await generator.save(saveURL);
    console.log(
        `epoch ${epoch + 1} elapsed time: ` +
        `${((tf.util.now() - tBatchBegin) / 1e3).toFixed(1)} s`);
    console.log(`Saved generator model to: ${saveURL}\n`);
  }
}

run();
