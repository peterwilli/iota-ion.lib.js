var path = require('path');

module.exports = {
  entry: './src/main.js',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'iota-ion.lib.js',
    library: 'ION'
  }
};
