const path = require('path');
const HtmlWebpackPlugin = require('html-webpack-plugin');

// Multi-page app: every destination is a real HTML file served at its own URL.
// They all share the single `app` bundle, which renders the page named in
// <body data-page="..."> and reconstructs state from the URL query string.
const PAGES = [
  { filename: 'index.html', page: 'home' },         // sign-in, teams, championship list + create wizard
  { filename: 'bracket.html', page: 'bracket' },    // ?id=<championshipId>
  { filename: 'match.html', page: 'match' },         // ?id=&match=<matchId>
  { filename: 'match-info.html', page: 'info' },     // ?id=&match=&map=<mapIdx>
  { filename: 'dashboard.html', page: 'dashboard' }, // ?scope=championship|global[&id=]
];

module.exports = {
  entry: {
    app: './js/app.js',
  },
  output: {
    path: path.resolve(__dirname, 'dist'),
    clean: true,
    filename: './js/app.js',
  },
  // One template (index.html) drives every page; `page` is read inside the
  // template as `htmlWebpackPlugin.options.page` to set <body data-page>. The
  // template must NOT include its own <script> for the app, or it would load
  // (and run) twice — double event handlers, double dialogs.
  plugins: PAGES.map(
    (p) => new HtmlWebpackPlugin({
      template: './index.html',
      filename: p.filename,
      page: p.page,
      chunks: ['app'],
    })
  ),
};
