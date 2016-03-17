'use strict';

module.exports = function(S) {

  const SError = require(S.getServerlessPath('Error')),
    SCli       = require(S.getServerlessPath('utils/cli')),
    _          = require('lodash'),
    BbPromise  = require('bluebird'),
    chalk      = require('chalk'),
    spawnSync  = require('child_process').spawnSync,
    browserify = require('browserify'),
    babelify   = require('babelify'),
    minifyify  = require('minifyify'),
    path       = require('path'),
    fs         = BbPromise.promisifyAll(require('fs'));

  class RuntimeBabel extends S.classes.Runtime {

    constructor() {
      super();
    }

    static getName() {
      return 'babel';
    }

    getName(providerName) {
      if (providerName === 'aws') {
        return 'nodejs'
      } else {
        return RuntimeBabel.getName();
      }
    }

    /**
     * Scaffold
     * - Create scaffolding for new Node.js function
     */

    scaffold(func) {
      const handlerPath = path.resolve(__dirname, '..', 'templates', 'handler.js');

      func.handler = 'handler.default';

      return fs.readFileAsync(handlerPath)
        .then(handlerJs => BbPromise.all([
          func.save(),
          S.utils.writeFile(func.getRootPath('handler.js'), handlerJs),
          S.utils.writeFile(func.getRootPath('event.json'), {})
        ]));
    }

    /**
     * Run
     * - Run this function locally
     */

    run(func, stage, region) {

      return BbPromise.all([
          S.utils.readFile(func.getRootPath('event.json')),
          this.getEnvVars(func, stage, region)
        ])
        .spread((event, envVars) => {
          const childArgs = [__dirname + '/babel-runner'];
          const resultSep = '___serverless_function_run_results___'
          const input = JSON.stringify({
            event,
            resultSep,
            handler: func.handler,
            name: func.getDeployedName({stage, region}),
            dir: func.getRootPath(),
            babelOptions: this.getBabelOptions(func)
          });

          const env = _.merge(envVars, process.env, {
            NODE_PATH: path.resolve(__dirname, '..', 'node_modules')
          })

          const child = spawnSync(process.execPath, childArgs, {env, input});

          if (child.error) return BbPromise.reject(child.error);

          if (!_.isEmpty(child.stderr.toString())) {
            SCli.log(chalk.red.bold('Failed - This Error Was Thrown:'));
            console.error(child.stderr.toString());
            return BbPromise.resolve()
          }

          const resultArray = child.stdout.toString().split(resultSep);
          const results = JSON.parse(resultArray[1]);

          if (!_.isEmpty(resultArray[0])) process.stdout.write(resultArray[0]);

          if (results.status === 'success') {
            SCli.log(chalk.green.bold('Success! - This Response Was Returned:'));
            console.log(JSON.stringify(results.response, null, 2));
          } else {
            SCli.log(chalk.red.bold('Failed - This Error Was Returned:'));
            SCli.log(results.response);
            if (results.stack) console.log(results.stack);
          }

          return BbPromise.resolve(results);
        });
    }

    /**
     * Build
     * - Build the function in this runtime
     */

    build(func, stage, region) {

      // Validate
      if (!func._class || func._class !== 'Function') return BbPromise.reject(new SError('A function instance is required'));

      let pathDist;

      return this.createDistDir(func.name)
        .then(distDir => pathDist = distDir)
        .then(() => this.copyFunction(func, pathDist, stage, region))
        .then(() => this._addEnvVarsInline(func, pathDist, stage, region))
        .then(() => this._browserify(func, pathDist))
        // .then(() => this.generatePaths(func, pathDist));
    }

    getBabelOptions(func) {
      return _.defaults(_.get(func, 'custom.runtime.babel'), {
        presets: ['es2015']
      });
    }

    _browserify(func, pathDist) {
      const config = _.defaultsDeep(_.get(func, 'custom.runtime'), {
        babel: this.getBabelOptions(func),
        handlerExt:   'js',
        includePaths: [],
        requires:     [],
        plugins:      [],
        transforms:   [{name: 'babelify', opts: this.getBabelOptions(func)}],
        exclude:      [],
        ignore:       [],
        extensions:   [],
        minify: true
      });

      if (config.minify) {
        config.plugins.push({
          name: 'minifyify',
          opts: {map: false}
        });
      }

      const handlerFileName = this.getHandler(func).split('.')[0] + '.' + config.handlerExt;

      let b = browserify({
        basedir:          pathDist,
        entries:          [handlerFileName],
        standalone:       'lambda',
        extensions:       config.extensions,
        browserField:     false,  // Setup for node app (copy logic of --node in bin/args.js)
        builtins:         false,
        commondir:        false,
        // ignoreMissing:    true,  // Do not fail on missing optional dependencies
        detectGlobals:    true,  // Default for bare in cli is true, but we don't care if its slower
        insertGlobalVars: {      // Handle process https://github.com/substack/node-browserify/issues/1277
          //__filename: insertGlobals.lets.__filename,
          //__dirname: insertGlobals.lets.__dirname,
          process: function() {}
        }
      });

      // browserify.require / .plugin / .transform
      ['require', 'plugin', 'transform'].forEach(key => {
        config[key + 's'].map(item => {
          if (_.isString(item)) item = {name: item};
          let val = (key === 'require' ? item.name : require(item.name));
          b[key](val, item.opts);
        });
      });

      // browserify.exclude
      config.exclude.forEach(file => b.exclude(file));

      // browserify.ignore
      config.ignore.forEach(file => b.ignore(file));

      // Perform Bundle
      const pathBundle = path.join(pathDist, 'bundle.js');

      return BbPromise.fromCallback(cb => b.bundle(cb))
        .then((buf) => fs.writeFileAsync(pathBundle, buf))
        .then(() => {
          let pathsPackaged = [
            {
              name: handlerFileName,
              path: pathBundle
            }
          ];

          // Reassign pathsPackages property
          // pathsPackaged = pathsPackaged.concat(this._generateIncludePaths());

          return pathsPackaged;
        });
    }


    /**
     * Get Handler
     */

    getHandler(func) {
      return path.join(path.dirname(func.handler), "_serverless_handler.handler").replace(/\\/g, '/');
    }

    /**
     * Install NPM Dependencies
     */

    installDependencies(dir) {
      SCli.log(`Installing NPM dependencies in dir: ${dir}`);
      SCli.log(`-----------------`);
      S.utils.npmInstall(S.getProject().getRootPath(dir));
      SCli.log(`-----------------`);
    }

    /**
     * Add ENV Vars In-line
     * - Adds a new handler that loads in ENV vars before running the main handler
     */

    _addEnvVarsInline(func, pathDist, stage, region) {

      return this.getEnvVars(func, stage, region)
        .then(envVars => {

          const handlerArr = func.handler.split('.'),
            handlerDir = path.dirname(func.handler),
            handlerFile = handlerArr[0].split('/').pop(),
            handlerMethod = handlerArr[1];

          const loader = `
          var envVars = ${JSON.stringify(envVars, null, 2)};
          for (var key in envVars) {
            process.env[key] = envVars[key];
          }
          exports.handler = require("./${handlerFile}")["${handlerMethod}"];
        `;

          return fs.writeFileAsync(path.join(pathDist, handlerDir, '_serverless_handler.js'), loader);
        });
    }
  }

  return RuntimeBabel;

};