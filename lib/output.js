/**
 * Shared output module for claude-patching
 *
 * Outputs structured JSON (JSONL) when CLAUDECODE=1, human-readable text otherwise.
 */

const isJsonMode = process.env.CLAUDECODE === '1';

/**
 * Write a line to stdout
 */
function writeLine(str) {
  process.stdout.write(str + '\n');
}

/**
 * Write a line to stderr
 */
function writeError(str) {
  process.stderr.write(str + '\n');
}

/**
 * Emit a JSON event to stdout
 */
function emitJson(obj) {
  writeLine(JSON.stringify(obj));
}

/**
 * Section - groups related output (like "=== Patch 1: Description ===")
 * @param {string} title - Section title
 * @param {Object} opts - Options
 * @param {number} [opts.index] - Section index number
 */
function section(title, opts = {}) {
  if (isJsonMode) {
    const event = { type: 'section', title };
    if (opts.index !== undefined) event.index = opts.index;
    emitJson(event);
  } else {
    if (opts.index !== undefined) {
      writeLine(`=== Patch ${opts.index}: ${title} ===`);
    } else {
      writeLine(`=== ${title} ===`);
    }
  }
}

/**
 * Discovery - found a pattern/variable
 * @param {string} label - What was found
 * @param {string} value - The found value
 * @param {Record<string, string>} [details] - Additional key-value details
 */
function discovery(label, value, details = null) {
  if (isJsonMode) {
    emitJson({ type: 'discovery', label, value, details });
  } else {
    writeLine(`Found ${label}: ${value}`);
    if (details) {
      for (const [key, val] of Object.entries(details)) {
        writeLine(`  ${key}: ${val}`);
      }
    }
  }
}

/**
 * Modification - before/after code change
 * @param {string} label - What's being modified
 * @param {string} before - Original code
 * @param {string} after - New code
 */
function modification(label, before, after) {
  if (isJsonMode) {
    emitJson({ type: 'modification', label, before, after });
  } else {
    writeLine(`Old: ${before}`);
    writeLine(`New: ${after}`);
  }
}

/**
 * Warning - non-fatal issue
 * @param {string} message - Warning message
 * @param {string[]} [details] - Additional detail lines
 */
function warning(message, details = null) {
  if (isJsonMode) {
    emitJson({ type: 'warning', message, details });
  } else {
    writeError(`Warning: ${message}`);
    if (details) {
      for (const detail of details) {
        writeError(`  ${detail}`);
      }
    }
  }
}

/**
 * Error - fatal issue (always to stderr)
 * @param {string} message - Error message
 * @param {string[]} [details] - Additional detail lines
 */
function error(message, details = null) {
  if (isJsonMode) {
    emitJson({ type: 'error', message, details });
  } else {
    writeError(`Error: ${message}`);
    if (details) {
      for (const detail of details) {
        writeError(`  ${detail}`);
      }
    }
  }
}

/**
 * Result - final outcome
 * @param {'success'|'failure'|'skipped'|'dry_run'} status - Outcome status
 * @param {string} message - Result message
 */
function result(status, message) {
  if (isJsonMode) {
    emitJson({ type: 'result', status, message });
  } else {
    switch (status) {
      case 'success':
        writeLine(`✓ ${message}`);
        break;
      case 'failure':
        writeLine(`✗ ${message}`);
        break;
      case 'dry_run':
        writeLine(`(Dry run) ${message}`);
        break;
      case 'skipped':
        writeLine(`⊘ ${message}`);
        break;
      default:
        writeLine(message);
    }
  }
}

/**
 * Info - general informational message
 * @param {string} message - Info message
 */
function info(message) {
  if (isJsonMode) {
    emitJson({ type: 'info', message });
  } else {
    writeLine(message);
  }
}

module.exports = {
  isJsonMode,
  section,
  discovery,
  modification,
  warning,
  error,
  result,
  info,
};
