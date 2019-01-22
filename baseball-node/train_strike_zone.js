require('@tensorflow/tfjs-node');
const argparse = require('argparse');
const sz_model = require('./strike_zone');

async function run(epochCount, savePath) {
  sz_model.model.summary();
  await sz_model.model.fitDataset(sz_model.trainingData, {
    epochs: epochCount,
    callbacks: {
      onEpochEnd: async (epoch, logs) => {
        console.log(`Epoch: ${epoch} - loss: ${logs.loss}`);
      }
    }
  });

  // Eval against test data:
  await sz_model.testValidationData.forEach((data) => {
    const evalOutput =
        sz_model.model.evaluate(data[0], data[1], sz_model.TEST_DATA_LENGTH);

    console.log(
        `\nEvaluation result:\n` +
        `  Loss = ${evalOutput[0].dataSync()[0].toFixed(3)}; ` +
        `Accuracy = ${evalOutput[1].dataSync()[0].toFixed(3)}`);
  });

  if (savePath !== null) {
    await sz_model.model.save(`file://${savePath}`);
    console.log(`Saved model to path: ${savePath}`);
  }
}

const parser = new argparse.ArgumentParser(
    {description: 'TensorFlow.js Strike Zone Training Example', addHelp: true});
parser.addArgument('--epochs', {
  type: 'int',
  defaultValue: 20,
  help: 'Number of epochs to train the model for.'
})
parser.addArgument('--model_save_path', {
  type: 'string',
  help: 'Path to which the model will be saved after training.'
});

const args = parser.parseArgs();

run(args.epochs, args.model_save_path);
