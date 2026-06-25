const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

module.exports = {
  entry: {
    app: './js/app.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    clean: true,
    filename: './js/app.js',
  },
  plugins: [
    // Generates index.html from the template and injects the bundled script
    // exactly once. The template must NOT include its own <script> for the app,
    // or it would load (and run) twice — double event handlers, double dialogs.
    new HtmlWebpackPlugin({
      template: './index.html',
    }),
  ],
};
