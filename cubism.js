(function(exports){
var cubism = exports.cubism = {version: "0.0.1"};
var cubism_id = 0;
function cubism_identity(d) { return d; }
cubism.option = function(name, value) {
  var options = location.search.substring(1).split("&"),
      i = -1,
      n = options.length,
      o;
  while (++i < n) {
    if ((o = options[i].split("="))[0] == name) {
      return decodeURIComponent(o[1]);
    }
  }
  return value;
};
function cubism_source(context, request) {
  var source = {};

  source.metric = function(expression) {
    var metric = new cubism_metric(context, expression),
        start0 = -Infinity,
        step = context.step(),
        size = context.size(),
        values = [],
        event = d3.dispatch("change"),
        listening = 0,
        beforechangeId = "beforechange.source-metric-" + ++cubism_id;

    function beforechange(start, stop) {
      var steps = Math.min(size, Math.round((start - start0) / step));
      if (!steps) return; // already fetched this window; ignore it!
      values.splice(0, steps);
      steps = Math.min(size, steps + cubism_sourceOverlap);
      start0 = start;
      request(expression, new Date(stop - steps * step), stop, step, function(error, data) {
        if (error) return console.warn(error);
        for (var j = 0, i = size - steps, m = data.length; j < m; ++j) values[j + i] = data[j];
        event.change.call(metric, start, stop);
      });
    }

    //
    metric.valueAt = function(i) {
      return values[i];
    };

    //
    metric.shift = function(offset) {
      return cubism_source(context, cubism_sourceShift(request, +offset)).metric(expression);
    };

    //
    metric.on = function(type, listener) {
      if (!arguments.length) return event.on(type);
      if (listener == null && event.on(type) != null) --listening;
      if (listener != null && event.on(type) == null) ++listening;
      context.on(beforechangeId, listening > 0 ? beforechange : null);
      event.on(type, listener);
      return metric;
    };

    return metric;
  };

  return source;
}

// Number of metric to refetch each period, in case of lag.
var cubism_sourceOverlap = 6;

// Wraps the specified request implementation, and shifts time by the given offset.
function cubism_sourceShift(request, offset) {
  return function(expression, start, stop, step, callback) {
    request(expression, new Date(+start + offset), new Date(+stop + offset), step, callback);
  };
}
function cubism_metric(context, expression) {
  if (!(context instanceof cubism_context)) throw new Error("invalid context");
  expression = expression + "";
  this.context = context;
  this.toString = function() { return expression; };
}

var cubism_metricPrototype = cubism_metric.prototype;

cubism_metricPrototype.valueAt = function() {
  return NaN;
};

cubism_metricPrototype.extent = function() {
  var i = 0,
      n = this.context.size(),
      value,
      min = Infinity,
      max = -Infinity;
  while (++i < n) {
    value = this.valueAt(i);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return [min, max];
};

cubism_metricPrototype.on = function(type, listener) {
  return arguments.length < 2 ? null : this;
};

cubism_metricPrototype.add = cubism_metricOperator("+", function(left, right) {
  return left + right;
});

cubism_metricPrototype.subtract = cubism_metricOperator("-", function(left, right) {
  return left - right;
});

cubism_metricPrototype.multiply = cubism_metricOperator("*", function(left, right) {
  return left * right;
});

cubism_metricPrototype.divide = cubism_metricOperator("/", function(left, right) {
  return left / right;
});

cubism_metricPrototype.shift = function() {
  return this;
};

cubism_metricPrototype.on = function() {
  return arguments.length < 2 ? null : this;
};

function cubism_metricOperator(name, operate) {

  function cubism_metricOperator(left, right) {
    if (!(right instanceof cubism_metric)) right = new cubism_metricConstant(left.context, right);
    else if (left.context !== right.context) throw new Error("mismatch context");
    cubism_metric.call(this, left.context, left + " " + name + " " + right);
    this.left = left;
    this.right = right;
  }

  var cubism_metricOperatorPrototype = cubism_metricOperator.prototype = Object.create(cubism_metric.prototype);

  cubism_metricOperatorPrototype.valueAt = function(i) {
    return operate(this.left.valueAt(i), this.right.valueAt(i));
  };

  cubism_metricOperatorPrototype.shift = function(offset) {
    return new cubism_metricOperator(this.left.shift(offset), this.right.shift(offset));
  };

  cubism_metricOperatorPrototype.on = function(type, listener) {
    if (arguments.length < 2) return this.left.on(type);
    this.left.on(type, listener);
    this.right.on(type, listener);
    return this;
  };

  return function(right) {
    return new cubism_metricOperator(this, right);
  };
}

function cubism_metricConstant(context, value) {
  cubism_metric.call(this, context, value = +value);
  this.valueOf = function() { return value; };
}

var cubism_metricConstantPrototype = cubism_metricConstant.prototype = Object.create(cubism_metric.prototype);

cubism_metricConstantPrototype.valueAt = function() {
  return +this;
};

cubism_metricConstantPrototype.extent = function() {
  return [+this, +this];
};
cubism_context.prototype.cube = function(host) {
  if (!arguments.length) host = "";

  var source = cubism_source(this, function(expression, start, stop, step, callback) {
    d3.json(host + "/1.0/metric"
        + "?expression=" + encodeURIComponent(expression)
        + "&start=" + cubism_cubeFormatDate(start)
        + "&stop=" + cubism_cubeFormatDate(stop)
        + "&step=" + step, function(data) {
      if (!data) return callback(new Error("unable to load data"));
      callback(null, data.map(function(d) { return d.value; }));
    });
  });

  // Returns the Cube host.
  source.toString = function() {
    return host;
  };

  return source;
};

var cubism_cubeFormatDate = d3.time.format.iso;
cubism_context.prototype.graphite = function(host) {
  if (!arguments.length) host = "";

  var source = cubism_source(this, function(expression, start, stop, step, callback) {
    d3.text(host + "/render?format=raw"
        + "&target=" + encodeURIComponent("alias(" + expression + ",'')")
        + "&from=" + cubism_graphiteFormatDate(start - 2 * step) // off-by-two?
        + "&until=" + cubism_graphiteFormatDate(stop - 1000), function(text) {
      if (!text) return callback(new Error("unable to load data"));
      callback(null, cubism_graphiteParse(text));
    });
  });

  source.find = function(pattern, callback) {
    d3.json(host + "/metrics/find?format=completer"
        + "&query=" + encodeURIComponent(pattern), function(result) {
      if (!result) return callback(new Error("unable to find metrics"));
      callback(null, result.metrics.map(function(d) { return d.path; }));
    });
  };

  // Returns the graphite host.
  source.toString = function() {
    return host;
  };

  return source;
};

// Graphite understands seconds since UNIX epoch.
function cubism_graphiteFormatDate(time) {
  return Math.floor(time / 1000);
}

// Helper method for parsing graphite's raw format.
function cubism_graphiteParse(text) {
  var i = text.indexOf("|"),
      meta = text.substring(0, i),
      c = meta.lastIndexOf(","),
      b = meta.lastIndexOf(",", c - 1),
      a = meta.lastIndexOf(",", b - 1),
      start = meta.substring(a + 1, b) * 1000,
      step = meta.substring(c + 1) * 1000;
  return text
      .substring(i + 1)
      .split(",")
      .slice(1) // the first value is always None?
      .map(function(d) { return +d; });
}
cubism.context = function() {
  var context = new cubism_context,
      step = 1e4, // ten seconds, in milliseconds
      size = 1440, // four hours at ten seconds, in pixels
      start0, stop0, // the start and stop for the previous change event
      start1, stop1, // the start and stop for the next beforechange event
      serverDelay = 5e3,
      clientDelay = 5e3,
      event = d3.dispatch("beforechange", "change"),
      scale = context.scale = d3.time.scale().range([0, size]);

  function update() {
    var now = Date.now();
    stop0 = new Date(Math.floor((now - serverDelay - clientDelay) / step) * step);
    start0 = new Date(stop0 - size * step);
    stop1 = new Date(Math.floor((now - serverDelay) / step) * step);
    start1 = new Date(stop1 - size * step);
    scale.domain([start0, stop0]);
    return context;
  }

  setTimeout(function() {
    var delay = +stop1 + serverDelay - Date.now();

    // If we're too late for the first beforechange event, skip it.
    if (delay < clientDelay) delay += step;

    setTimeout(function beforechange() {
      stop1 = new Date(Math.floor((Date.now() - serverDelay) / step) * step);
      start1 = new Date(stop1 - size * step);
      event.beforechange.call(context, start1, stop1);

      setTimeout(function() {
        scale.domain([start0 = start1, stop0 = stop1]);
        event.change.call(context, start1, stop1);
      }, clientDelay);

      setTimeout(beforechange, step);
    }, delay);
  }, 10);

  // Set or get the step interval in milliseconds.
  // Defaults to ten seconds.
  context.step = function(_) {
    if (!arguments.length) return step;
    step = +_;
    return update();
  };

  // Set or get the context size (the count of metric values).
  // Defaults to 1440 (four hours at ten seconds).
  context.size = function(_) {
    if (!arguments.length) return size;
    scale.range([0, size = +_]);
    return update();
  };

  // The server delay is the amount of time we wait for the server to compute a
  // metric. This delay may result from clock skew or from delays collecting
  // metrics from various hosts. Defaults to 4 seconds.
  context.serverDelay = function(_) {
    if (!arguments.length) return serverDelay;
    serverDelay = +_;
    return update();
  };

  // The client delay is the amount of additional time we wait to fetch those
  // metrics from the server. The client and server delay combined represent the
  // age of the most recent displayed metric. Defaults to 1 second.
  context.clientDelay = function(_) {
    if (!arguments.length) return clientDelay;
    clientDelay = +_;
    return update();
  };

  // Add, remove or get listeners for "change" and "beforechange" events.
  context.on = function(type, listener) {
    if (arguments.length < 2) return event.on(type);
    event.on(type, listener);

    // Notify the listener of the current start and stop time, as appropriate.
    // This way, metrics can make requests for data immediately,
    // and likewise the axis can display itself synchronously.
    if (listener != null) {
      if (/^beforechange(\.|$)/.test(type)) listener.call(context, start1, stop1);
      if (/^change(\.|$)/.test(type)) listener.call(context, start0, stop0);
    }

    return context;
  };

  return update();
};

function cubism_context() {}

cubism_context.prototype.constant = function(value) {
  return new cubism_metricConstant(this, +value);
};
cubism_context.prototype.horizon = function() {
  var context = this,
      mode = "offset",
      width = context.size(),
      height = 30,
      scale = d3.scale.linear().interpolate(d3.interpolateRound),
      metric = cubism_identity,
      extent = null,
      title = cubism_identity,
      format = d3.format(".2s"),
      colors = ["#08519c","#3182bd","#6baed6","#bdd7e7","#bae4b3","#74c476","#31a354","#006d2c"];

  function horizon(selection) {

    selection.append("canvas")
        .attr("width", width)
        .attr("height", height);

    selection.append("span")
        .attr("class", "title")
        .text(title);

    selection.append("span")
        .attr("class", "value");

    selection.each(function(d, i) {
      var that = this,
          id = ++cubism_id,
          canvas = d3.select(that).select("canvas").node().getContext("2d"),
          value = d3.select(that).select(".value"),
          metric_ = typeof metric === "function" ? metric.call(that, d, i) : metric,
          colors_ = typeof colors === "function" ? colors.call(that, d, i) : colors,
          extent_ = typeof extent === "function" ? extent.call(that, d, i) : extent,
          m = colors_.length >> 1,
          ready;

      function change(start, stop) {
        canvas.clearRect(0, 0, width, height);

        // update the domain
        var extent = metric_.extent();
        ready = extent.every(isFinite);
        if (extent_ != null) extent = extent_;
        scale.domain([0, Math.max(extent[0], extent[1])]);

        // value
        var y1 = metric_.valueAt(width - 1);
        value.datum(y1).text(isNaN(y1) ? null : format);

        // record whether there are negative values to display
        var negative;

        // positive bands
        for (var j = 0; j < m; ++j) {
          canvas.fillStyle = colors_[m + j];

          // Adjust the range based on the current band index.
          var y0 = (j - m + 1) * height;
          scale.range([m * height + y0, y0]);
          y0 = scale(0);

          for (var i = 0, n = width; i < n; ++i) {
            y1 = metric_.valueAt(i);
            if (y1 <= 0) { negative = true; continue; }
            canvas.fillRect(i, y1 = scale(y1), 1, y0 - y1);
          }
        }

        if (negative) {
          // enable offset mode
          if (mode === "offset") {
            canvas.save();
            canvas.translate(0, height);
            canvas.scale(1, -1);
          }

          // negative bands
          for (var j = 0; j < m; ++j) {
            canvas.fillStyle = colors_[m - 1 - j];

            // Adjust the range based on the current band index.
            var y0 = (j - m + 1) * height;
            scale.range([m * height + y0, y0]);
            y0 = scale(0);

            for (var i = 0, n = width; i < n; ++i) {
              y1 = metric_.valueAt(i);
              if (y1 >= 0) continue;
              canvas.fillRect(i, scale(-y1), 1, y0 - scale(-y1));
            }
          }

          // undo offset mode
          if (mode === "offset") {
            canvas.restore();
          }
        }
      }

      // Display the first metric change immediately,
      // but defer subsequent updates to the canvas change.
      // Note that someone still needs to listen to the metric,
      // so that it continues to update automatically.
      metric_.on("change.horizon-" + id, function(start, stop) {
        change(start, stop);
        if (ready) metric_.on("change.horizon-" + id, cubism_identity);
      });

      // Update the chart when the context changes.
      context.on("change.horizon-" + id, change);
    });
   }

  horizon.mode = function(_) {
    if (!arguments.length) return mode;
    mode = _ + "";
    return horizon;
  };

  horizon.height = function(_) {
    if (!arguments.length) return height;
    height = +_;
    return horizon;
  };

  horizon.metric = function(_) {
    if (!arguments.length) return metric;
    metric = _;
    return horizon;
  };

  horizon.scale = function(_) {
    if (!arguments.length) return scale;
    scale = _;
    return horizon;
  };

  horizon.extent = function(_) {
    if (!arguments.length) return extent;
    extent = _;
    return horizon;
  };

  horizon.title = function(_) {
    if (!arguments.length) return title;
    title = _;
    return horizon;
  };

  horizon.format = function(_) {
    if (!arguments.length) return format;
    format = _;
    return horizon;
  };

  horizon.colors = function(_) {
    if (!arguments.length) return colors;
    colors = _;
    return horizon;
  };

  return horizon;
};
cubism_context.prototype.comparison = function() {
  var context = this,
      width = context.size(),
      height = 120,
      scale = d3.scale.linear().interpolate(d3.interpolateRound),
      primary = function(d) { return d[0]; },
      secondary = function(d) { return d[1]; },
      extent = null,
      title = cubism_identity,
      formatPrimary = cubism_comparisonPrimaryFormat,
      formatChange = cubism_comparisonChangeFormat,
      colors = ["#9ecae1", "#3182bd", "#a1d99b", "#31a354"],
      strokeWidth = 1.5;

  function comparison(selection) {

    selection.append("canvas")
        .attr("width", width)
        .attr("height", height);

    selection.append("span")
        .attr("class", "title")
        .text(title);

    selection.append("span")
        .attr("class", "value primary");

    selection.append("span")
        .attr("class", "value change");

    selection.each(function(d, i) {
      var that = this,
          id = ++cubism_id,
          div = d3.select(that),
          canvas = div.select("canvas").node().getContext("2d"),
          spanPrimary = div.select(".value.primary"),
          spanChange = div.select(".value.change"),
          primary_ = typeof primary === "function" ? primary.call(that, d, i) : primary,
          secondary_ = typeof secondary === "function" ? secondary.call(that, d, i) : secondary,
          extent_ = typeof extent === "function" ? extent.call(that, d, i) : extent,
          ready;

      function change(start, stop) {
        canvas.save();
        canvas.clearRect(0, 0, width, height);

        // update the scale
        var primaryExtent = primary_.extent(),
            secondaryExtent = secondary_.extent(),
            extent = extent_ == null ? primaryExtent : extent_;
        scale.domain([0, extent[1]]).range([height, 0]);
        ready = primaryExtent.concat(secondaryExtent).every(isFinite);

        // value
        var valuePrimary = primary_.valueAt(width - 1),
            valueSecondary = secondary_.valueAt(width - 1),
            valueChange = (valuePrimary - valueSecondary) / valueSecondary;

        spanPrimary
            .datum(valuePrimary)
            .text(isNaN(valuePrimary) ? null : formatPrimary);

        spanChange
            .datum(valueChange)
            .text(isNaN(valueChange) ? null : formatChange)
            .attr("class", "value change " + (valueChange > 0 ? "positive" : valueChange < 0 ? "negative" : ""));

        // positive changes
        canvas.fillStyle = colors[2];
        for (var i = 0, n = width; i < n; ++i) {
          var y0 = scale(primary_.valueAt(i)),
              y1 = scale(secondary_.valueAt(i));
          if (y0 < y1) canvas.fillRect(i & 0xfffffe, y0, 1, y1 - y0);
        }

        // negative changes
        canvas.fillStyle = colors[0];
        for (i = 0; i < n; ++i) {
          var y0 = scale(primary_.valueAt(i)),
              y1 = scale(secondary_.valueAt(i));
          if (y0 > y1) canvas.fillRect(i & 0xfffffe, y1, 1, y0 - y1);
        }

        // positive values
        canvas.fillStyle = colors[3];
        for (i = 0; i < n; ++i) {
          var y0 = scale(primary_.valueAt(i)),
              y1 = scale(secondary_.valueAt(i));
          if (y0 <= y1) canvas.fillRect(i & 0xfffffe, y0, 1, strokeWidth);
        }

        // negative values
        canvas.fillStyle = colors[1];
        for (i = 0; i < n; ++i) {
          var y0 = scale(primary_.valueAt(i)),
              y1 = scale(secondary_.valueAt(i));
          if (y0 > y1) canvas.fillRect(i & 0xfffffe, y0 - strokeWidth, 1, strokeWidth);
        }

        canvas.restore();
      }

      // Display the first primary change immediately,
      // but defer subsequent updates to the context change.
      // Note that someone still needs to listen to the metric,
      // so that it continues to update automatically.
      primary_.on("change.comparison-" + id, firstChange);
      secondary_.on("change.comparison-" + id, firstChange);
      function firstChange(start, stop) {
        change(start, stop);
        if (ready) {
          primary_.on("change.comparison-" + id, cubism_identity);
          secondary_.on("change.comparison-" + id, cubism_identity);
        }
      }

      // Update the chart when the context changes.
      context.on("change.comparison-" + id, change);
    });
   }

  comparison.height = function(_) {
    if (!arguments.length) return height;
    height = +_;
    return comparison;
  };

  comparison.primary = function(_) {
    if (!arguments.length) return primary;
    primary = _;
    return comparison;
  };

  comparison.secondary = function(_) {
    if (!arguments.length) return secondary;
    secondary = _;
    return comparison;
  };

  comparison.scale = function(_) {
    if (!arguments.length) return scale;
    scale = _;
    return comparison;
  };

  comparison.extent = function(_) {
    if (!arguments.length) return extent;
    extent = _;
    return comparison;
  };

  comparison.title = function(_) {
    if (!arguments.length) return title;
    title = _;
    return comparison;
  };

  comparison.formatPrimary = function(_) {
    if (!arguments.length) return formatPrimary;
    formatPrimary = _;
    return comparison;
  };

  comparison.formatChange = function(_) {
    if (!arguments.length) return formatChange;
    formatChange = _;
    return comparison;
  };

  comparison.colors = function(_) {
    if (!arguments.length) return colors;
    colors = _;
    return comparison;
  };

  comparison.strokeWidth = function(_) {
    if (!arguments.length) return strokeWidth;
    strokeWidth = _;
    return comparison;
  };

  return comparison;
};

var cubism_comparisonPrimaryFormat = d3.format(".2s"),
    cubism_comparisonChangeFormat = d3.format("+.0%");
cubism_context.prototype.axis = function() {
  var context = this,
      axis_ = d3.svg.axis().scale(context.scale);

  function axis(selection) {
    context.on("change.axis-" + ++cubism_id, function() {
      selection.call(axis_);
    });
  }

  return d3.rebind(axis, axis_,
      "orient",
      "ticks",
      "tickSubdivide",
      "tickSize",
      "tickPadding",
      "tickFormat");
};
})(this);
