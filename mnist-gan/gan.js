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

const fs = require('fs');
const path = require('path');

const tf = require('@tensorflow/tfjs');
require('@tensorflow/tfjs-node-gpu');

const data = require('./data');

const NUM_CLASSES = 10;

function buildGenerator(latentSize) {
  const cnn = tf.sequential();

  cnn.add(tf.layers.dense({
    units: 3 * 3 * 384,  // TODO(cais): DO NOT hardcode.
    inputShape: [latentSize],
    activation: 'relu'
  }));
  cnn.add(tf.layers.reshape({targetShape: [3, 3, 384]}));

  // Upsample to [7, 7, ...]
  cnn.add(tf.layers.conv2dTranspose({
    filters: 192,
    kernelSize: 5,
    strides: 1,
    padding: 'valid',
    activation: 'relu',
    kernelInitializer: 'glorotNormal'
  }));
  cnn.add(tf.layers.batchNormalization());

  // Upsample to [14, 14, ...]
  cnn.add(tf.layers.conv2dTranspose({
    filters: 96,
    kernelSize: 5,
    strides: 2,
    padding: 'same',
    activation: 'relu',
    kernelInitializer: 'glorotNormal'
  }));
  cnn.add(tf.layers.batchNormalization());

  // Upsample to [28, 28, ...]
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

  // This will be out label.
  const imageClass = tf.input({shape: [1]});

  const cls =
      tf.layers.flatten().apply(tf.layers
                                    .embedding({
                                      inputDim: NUM_CLASSES,
                                      outputDim: latentSize,
                                      embeddingsInitializer: 'glorotNormal'
                                    })
                                    .apply(imageClass));

  // Hadamard product between z-space and a class conditional embedding.
  const h = tf.layers.multiply().apply([latent, cls]);

  const fakeImage = cnn.apply(h);
  return tf.model({inputs: [latent, imageClass], outputs: fakeImage});
}

function buildDiscriminator() {
  const cnn = tf.sequential();

  cnn.add(tf.layers.conv2d({
    filters: 32,
    kernelSize: 3,
    padding: 'same',
    strides: 2,
    inputShape: [28, 28, 1]  // TODO(cais): Do not hard code.
  }));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.conv2d(
      {filters: 64, kernelSize: 3, padding: 'same', strides: 1}));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.conv2d(
      {filters: 128, kernelSize: 3, padding: 'same', strides: 1}));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.conv2d(
    {filters: 256, kernelSize: 3, padding: 'same', strides: 1}));
  cnn.add(tf.layers.leakyReLU({alpha: 0.2}));
  cnn.add(tf.layers.dropout({rate: 0.3}));

  cnn.add(tf.layers.flatten());

  const image = tf.input({shape: [28, 28, 1]});
  const features = cnn.apply(image);

  const fake =
      tf.layers.dense({units: 1, activation: 'sigmoid'}).apply(features);
  const aux = tf.layers.dense({units: NUM_CLASSES, activation: 'softmax'})
                  .apply(features);

  return tf.model({inputs: image, outputs: [fake, aux]});
}

async function run() {
  const epochs = 100;
  const batchSize = 100;
  const latentSize = 100;

  const learningRate = 0.0002;
  const adamBeta1 = 0.5;

  const savePath = './dist/generator';
  if (!fs.existsSync(path.dirname(savePath))) {
    fs.mkdirSync(path.dirname(savePath));
  }
  const saveURL = `file://${savePath}`;

  // Build the discriminator.
  const discriminator = buildDiscriminator();
  discriminator.compile({
    optimizer: tf.train.adam(learningRate, adamBeta1),
    loss: ['binaryCrossentropy', 'sparseCategoricalCrossentropy']
  });
  discriminator.summary();

  // Build the generator.
  const generator = buildGenerator(latentSize);
  generator.summary();

  const latent = tf.input({shape: [latentSize]});
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
  for (let epoch = 0; epoch < epochs; ++epoch) {
    const numBatches = Math.ceil(xTrain.shape[0] / batchSize);

    for (let index = 0; index < numBatches; ++index) {
      const actualBatchSize = (index + 1) * batchSize >= xTrain.shape[0] ?
          (xTrain.shape[0] - index * batchSize) :
          batchSize;
      const imageBatch = xTrain.slice(index * batchSize, actualBatchSize);
      const labelBatch =
          yTrain.slice(index * batchSize, actualBatchSize).asType('float32');

      let noise = tf.randomUniform([actualBatchSize, latentSize], -1, 1);
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

      const dHist = await discriminator.fit(
          x, [y, auxY], {batchSize: actualBatchSize, epochs: 1, verbose: 0});
      const dLoss = dHist.history.loss[0];
      tf.dispose([x, y, auxY]);

      // Make new noise. We generate 2 * actualBatchSize here, so that we have
      // the generator optimizer over an identical number of images
      // as the discriminator.
      tf.dispose([noise, sampledLabels]);
      noise = tf.randomUniform([2 * actualBatchSize, latentSize], -1, 1);
      sampledLabels =
          tf.randomUniform([2 * actualBatchSize, 1], 0, NUM_CLASSES, 'int32')
              .asType('float32');

      // We want to train the generator to trick the discriminator.
      // For the generator, we want all the {fake, not-fake} labels to say
      // not-fake.
      const trick =
          tf.tidy(() => tf.ones([2 * actualBatchSize, 1]).mul(softOne));

      const gHist = await combined.fit(
          [noise, sampledLabels], [trick, sampledLabels],
          {epochs: 1, batchSize: noise.shape[0], verbose: 0});
      const gLoss = gHist.history.loss[0];
      console.log(
          `Epoch ${epoch + 1} batch ${index + 1}: ` +
          `dLoss = ${dLoss.toFixed(6)}; gLoss = ${gLoss.toFixed(6)}`);
      tf.dispose([noise, trick]);
    }

    await generator.save(saveURL);
    console.log(`Saved generator model to: ${saveURL}\n`);
  }
}

run();
