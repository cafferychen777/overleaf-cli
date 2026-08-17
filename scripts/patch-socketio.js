#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
const socketPackagePath = require.resolve('socket.io-client/package.json', {paths: [packageRoot]});
const socketRoot = path.dirname(socketPackagePath);

function patchFile(relativePath, replacements) {
  const filePath = path.join(socketRoot, relativePath);
  let source = fs.readFileSync(filePath, 'utf8');

  for (const {before, after, previousAfter} of replacements) {
    if (source.includes(after)) {
      continue;
    }
    const sourceFragment = source.includes(before)
      ? before
      : (previousAfter && source.includes(previousAfter) ? previousAfter : undefined);
    if (!sourceFragment) {
      throw new Error(`Cannot patch ${filePath}: expected source fragment was not found.`);
    }
    source = source.replace(sourceFragment, after);
  }

  fs.writeFileSync(filePath, source, 'utf8');
}

patchFile('lib/socket.js', [
  {
    before: [
      "      if (this.isXDomain()) {",
      "        xhr.withCredentials = true;",
      "      }",
      "      xhr.onreadystatechange = function () {",
    ].join('\n'),
    after: [
      "      if (this.isXDomain()) {",
      "        xhr.withCredentials = true;",
      "      }",
      "      if (this.options['extraHeaders']) {",
      "        xhr.setDisableHeaderCheck(true);",
      "        Object.entries(this.options['extraHeaders']).forEach(([key, value]) => {",
      "          xhr.setRequestHeader(key, value);",
      "        });",
      "      }",
      "      xhr.onreadystatechange = function () {",
    ].join('\n'),
  },
  {
    before: [
      "          if (xhr.status == 200) {",
      "            complete(xhr.responseText);",
    ].join('\n'),
    previousAfter: [
      "          if (xhr.status == 200) {",
      "            // extract set-cookie headers",
      "            const matches = xhr.getAllResponseHeaders().match(/set-cookie:\\s*([^\\r\\n]+)/gi);",
      "            matches && matches.forEach(function (header) {",
      "              const newCookie = header.split(':')[1].split(';')[0].trim();",
      "              const optCookie = self.options['extraHeaders']['Cookie'];",
      "              const mergedCookie = optCookie ? `${optCookie}; ${newCookie}` : newCookie;",
      "              self.options['extraHeaders'] = self.options['extraHeaders'] || {};",
      "              self.options['extraHeaders']['Cookie'] = mergedCookie;",
      "            });",
      "",
      "            complete(xhr.responseText);",
    ].join('\n'),
    after: [
      "          if (xhr.status == 200) {",
      "            // extract set-cookie headers",
      "            const matches = xhr.getAllResponseHeaders().match(/set-cookie:\\s*([^\\r\\n]+)/gi);",
      "            matches && matches.forEach(function (header) {",
      "              const newCookie = header.split(':')[1].split(';')[0].trim();",
      "              const extraHeaders = self.options['extraHeaders'] || {};",
      "              const optCookie = extraHeaders['Cookie'];",
      "              const mergedCookie = optCookie ? `${optCookie}; ${newCookie}` : newCookie;",
      "              extraHeaders['Cookie'] = mergedCookie;",
      "              self.options['extraHeaders'] = extraHeaders;",
      "            });",
      "",
      "            complete(xhr.responseText);",
    ].join('\n'),
  },
  {
    before: "          self.transport.open();",
    after: "          self.transport.open(self.options['extraHeaders']);",
  },
  {
    before: [
      "    xhr.open('GET', uri, false);",
      "    xhr.send(null);",
    ].join('\n'),
    after: [
      "    xhr.open('GET', uri, false);",
      "    if (this.options['extraHeaders']) {",
      "      xhr.setDisableHeaderCheck(true);",
      "      Object.entries(this.options['extraHeaders']).forEach(([key, value]) => {",
      "        xhr.setRequestHeader(key, value);",
      "      });",
      "    }",
      "    xhr.send(null);",
    ].join('\n'),
  },
]);

patchFile('lib/transports/websocket.js', [
  {
    before: "  WS.prototype.open = function () {",
    after: "  WS.prototype.open = function (extraHeaders) {",
  },
  {
    before: "    this.websocket = new Socket(this.prepareUrl() + query);",
    after: [
      "    this.websocket = new Socket(this.prepareUrl() + query, {",
      "      headers: extraHeaders || {}",
      "    });",
    ].join('\n'),
  },
]);
