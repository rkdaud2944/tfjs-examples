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
 * Data object for Jena Weather data.
 *
 * TODO(cais): Say something about the origin of the data.
 */

import * as tf from '@tensorflow/tfjs';

const JENA_WEATHER_CSV_PATH =
    'https://storage.googleapis.com/learnjs-data/jena_climate/jena_climate_2009_2016.csv';

function parseDateTime(str) {
  const items = str.split(' ');
  const dateStr = items[0];
  const dateStrItems = dateStr.split('.');
  const day = +dateStrItems[0];
  const month = +dateStrItems[1];
  const year = +dateStrItems[2];

  const timeStrItems = items[1].split(':');
  const hours = +timeStrItems[0];
  const minutes = +timeStrItems[1];
  const seconds = +timeStrItems[2];

  return new Date(year, month, day, hours, minutes, seconds);
}

/**
 * A class that fetches the sprited MNIST dataset and provide data as
 * tf.Tensors.
 */
export class JenaWeatherData {
  constructor() {}

  async load() {
    const csvData = await (await fetch(JENA_WEATHER_CSV_PATH)).text();

    // Parse CSV file.
    const csvLines = csvData.split('\n');

    // Parser header.
    const columnNames = csvLines[0].split(',');
    for (let i = 0; i < columnNames.length; ++i) {
      columnNames[i] = columnNames[i].slice(1, columnNames[i].length - 1);
    }

    this.dateTimeCol = columnNames.indexOf('Date Time');
    tf.util.assert(
        this.dateTimeCol === 0,
        `Unexpected date-time column index from ${JENA_WEATHER_CSV_PATH}`);

    this.dataColumnNames = columnNames.slice(1);
    this.tempCol = columnNames.indexOf('T (degC)');
    tf.util.assert(
        this.tempCol >= 1,
        `Unexpected T (degC) column index from ${JENA_WEATHER_CSV_PATH}`);

    this.dateTime = [];
    this.data = [];
    for (let i = 1; i < csvLines.length; ++i) {
      const line = csvLines[i].trim();
      if (line.length === 0) {
        continue;
      }
      const items = line.split(',');
      this.dateTime.push(parseDateTime(items[0]));
      this.data.push(items.slice(1).map(x => +x));
    }
    this.numRows = this.data.length;
    console.log(`numRows: ${this.numRows}`);

    // TODO(cais): Normalization.
    await this.calculateMeansAndStddevs_();
  }

  /**
   * Calculate the means and standard deviations of every column.
   *
   * TensorFlow.js is used for acceleration.
   */
  async calculateMeansAndStddevs_() {
    tf.tidy(() => {
      // Instead of doing it on all columns at once, we do it
      // column by column, as doing it all at once causes WebGL OOM
      // on some machines.
      this.means = [];
      this.stddevs = [];
      for (const columnName of this.dataColumnNames) {
        // TODO(cais): See if we can relax this limit.
        const data =
            tf.tensor1d(this.getColumnData(columnName).slice(0, 6 * 24 * 365));
        const moments = tf.moments(data);
        this.means.push(moments.mean.dataSync());
        this.stddevs.push(Math.sqrt(moments.variance.dataSync()));
      }
      console.log('means:', this.means);
      console.log('stddevs:', this.stddevs);
    });
  }

  getDataColumnNames() {
    return this.dataColumnNames;
  }

  getTime(index) {
    return this.dateTime[index];
  }

  getColumnData(
      columnName, includeTime, normalize, beginIndex, length, stride) {
    const columnIndex = this.dataColumnNames.indexOf(columnName);
    tf.util.assert(columnIndex >= 0, `Invalid column name: ${columnName}`);

    if (beginIndex == null) {
      beginIndex = 0;
    }
    if (length == null) {
      length = this.numRows - beginIndex;
    }
    if (stride == null) {
      stride = 1;
    }
    const out = [];
    for (let i = beginIndex; i < beginIndex + length && i < this.numRows;
         i += stride) {
      let value = this.data[i][columnIndex];
      if (normalize) {
        value = (value - this.means[columnIndex]) / this.stddevs[columnIndex];
      }
      if (includeTime) {
        value = {x: this.dateTime[i].getTime(), y: value};
      }
      out.push(value);
    }
    return out;
  }
}
