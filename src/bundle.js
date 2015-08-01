'use strict';

var combineSourceMap = require('combine-source-map');
var convertSourceMap = require('convert-source-map');
var extend = require('extend');
var fs = require('fs');
var glob = require('./glob');
var mapStream = require('map-stream');
var minimatch = require('minimatch');
var through = require('through');
var vinylTransform = require('vinyl-transform');

function filesToPaths (files) {
  return files.map(function (file) {
    return file.path;
  });
}

function Bundle ($events, $file, $fs, $tracer, $watcher, paths, options) {
  this._options = extend({
    common: false,
    joiner: '\n\n'
  }, options);
  this._events = $events;
  this._file = $file;
  this._fs = $fs;
  this._tracer = $tracer;
  this._watcher = $watcher;
  this.files = glob(paths);
  this.init();
}

Bundle.prototype = {
  init: function () {
    var that = this;
    var traced = this._tracer.trace(this.files);
    var common = [];

    // Find duplicate files.
    var tracedDuplicates = traced.filter(function (value, index, self) {
      return self.indexOf(value) !== index;
    });

    // Find unique files.
    var tracedUniques = traced.filter(function (value, index, self) {
      return self.indexOf(value) === index;
    });

    // Ensure duplicate file dependencies are included and removed from unique.
    tracedDuplicates.forEach(function (duplicateFile) {
      that._tracer.trace(duplicateFile.path).forEach(function (duplicateFileDependency) {
        var indexInTracedDuplicates = common.indexOf(duplicateFileDependency);
        var indexInTracedUniques = tracedUniques.indexOf(duplicateFileDependency);

        if (indexInTracedDuplicates === -1) {
          common.push(duplicateFileDependency);
        }

        if (indexInTracedUniques !== -1) {
          tracedUniques.splice(indexInTracedUniques, 1);
        }
      });
    });

    this.all = filesToPaths(traced);
    this.common = filesToPaths(common);
    this.commonDestination = this._commonDestination();
    this.uncommon = filesToPaths(tracedUniques);

    return this;
  },

  destinations: function (file) {
    var that = this;
    var mainDestinations = [];

    if (this.common.indexOf(file) !== -1 && this.commonDestination) {
      return [this.commonDestination];
    }

    this.files.forEach(function (mainFile) {
      that._tracer.trace(mainFile).some(function (tracedFile) {
        if (file === tracedFile.path) {
          mainDestinations.push(mainFile);
          return true;
        }
      });
    });

    return mainDestinations;
  },

  compile: function (paths) {
    var that = this;
    var bundled = [];
    var common = this.common;
    var files = this.files;
    var opts = this._options;
    var traced = [];

    // If paths are specified, we match those against bundle files. If not, then
    // we default it to the bundle files and generate the entire bundle.
    paths = paths || files;

    glob(paths).forEach(function (file) {
      // Only allow files that are defined in the bundle.
      if (files.indexOf(file) === -1) {
        return;
      }

      // Prepend the common dependencies if our option matches the file.
      if (typeof opts.common === 'string' && minimatch(file, opts.common)) {
        traced = traced.concat(common);
      }

      // Trace each dependency and only add them to the common array if they
      // aren't in there so that there are no duplicates.
      that._tracer.trace(file).forEach(function (dependency) {
        if (common.indexOf(dependency.path) === -1) {
          traced.push(dependency.path);
        }
      });

      // So that we can emit an event of which files were bundled.
      bundled.push(file);
    });

    var compiled = [];
    var compiledMap = combineSourceMap.create();
    var lastLine = 0;

    traced.forEach(function (path, index) {
      var file = that._file(path);
      var comp = file.transformed;
      var codeAndMap = comp.code + '\n\n' + convertSourceMap.fromObject(comp.map).toComment();

      that._events.emit('compile', path, index, traced, bundled);
      compiled.push(comp.code);
      compiledMap.addFile({
        source: codeAndMap
      }, {
        line: lastLine
      });
      lastLine += comp.code.split('\n').length;
    });

    return compiled.join('\n\n') + '\n\n' + compiledMap.comment();
  },

  compileOne: function (file) {
    file = this._file(file);
    return this.all.indexOf(file.path) === -1 ? '' : file.transformed.code;
  },

  stream: function () {
    var that = this;
    return vinylTransform(function (file) {
      return mapStream(function (data, next) {
        return next(null, that.compile(file));
      });
    });
  },

  streamOne: function () {
    var that = this;
    return vinylTransform(function (file) {
      return mapStream(function (data, next) {
        return next(null, that.compileOne(file));
      });
    });
  },

  watch: function (callback) {
    return this._watcher.watch(this, callback);
  },

  watchIf: function (condition, callback) {
    return condition ? this.watch(callback) : through();
  },

  _commonDestination: function () {
    var common;
    var commonOpt = this._options.common;

    commonOpt && this.files.some(function (file) {
      return minimatch(file, commonOpt) && (common = file);
    });

    return common || (fs.existsSync(commonOpt) && commonOpt);
  }
};

module.exports = Bundle;
