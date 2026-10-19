'use strict';

const path = require('path');
const { parse } = require('./parser');

// The files that a .http file refers to with < <@ > and >>, with the line and column of the path.
// A path with a variable in it is left out.
function fileReferences(text) {
  const lines = text.split(/\r?\n/);
  const found = [];
  for (const req of parse(text).requests) {
    for (const script of [...req.preScripts, ...req.handlers]) {
      if (script.file !== undefined) found.push({ path: script.file, line: script.line });
    }
    for (const part of req.body) if (part.type === 'file') found.push({ path: part.path, line: part.line });
    if (req.responseFile) found.push({ path: req.responseFile.path, line: req.responseFile.line, output: true });
  }
  return found.sort((a, b) => a.line - b.line).flatMap(ref => {
    if (ref.path.includes('{{')) return [];
    const start = lines[ref.line].indexOf(ref.path);
    return start < 0 ? [] : [{ ...ref, start, end: start + ref.path.length }];
  });
}

// Where a file or folder ends up after the renames: a moved folder takes everything inside it along.
function movedLocation(file, renames) {
  for (const { oldPath, newPath } of renames) {
    const relative = path.relative(oldPath, file);
    if (!relative) return newPath;
    if (!relative.startsWith('..') && !path.isAbsolute(relative)) return path.join(newPath, relative);
  }
  return file;
}

// The edits that keep the paths in the given .http files pointing at the same files after the renames.
// A path keeps its form: absolute stays absolute, and a leading ./ stays where it still fits.
// Each edit names the .http file at its new location.
function movedReferenceEdits(httpFiles, renames) {
  const moves = renames.map(({ oldPath, newPath }) => ({ oldPath: path.resolve(oldPath), newPath: path.resolve(newPath) }));
  const edits = [];
  for (const { fsPath, text } of httpFiles) {
    const oldFile = path.resolve(fsPath);
    const newFile = movedLocation(oldFile, moves);
    for (const ref of fileReferences(text)) {
      const oldTarget = path.resolve(path.dirname(oldFile), ref.path);
      const newTarget = movedLocation(oldTarget, moves);
      if (oldTarget === newTarget && oldFile === newFile) continue;

      let newText;
      if (path.isAbsolute(ref.path)) {
        newText = newTarget;
      } else {
        newText = path.relative(path.dirname(newFile), newTarget).split(path.sep).join('/');
        if (ref.path.startsWith('./') && !newText.startsWith('../')) newText = `./${newText}`;
      }
      if (newText !== ref.path) edits.push({ fsPath: newFile, line: ref.line, start: ref.start, end: ref.end, newText });
    }
  }
  return edits;
}

module.exports = { fileReferences, movedReferenceEdits };
