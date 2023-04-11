/**
 * Copyright 2019, 2023 IBM Corp. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
const { KubeClass } = require('@razee/kubernetes-util');
const kc = new KubeClass();
var log = require(`${__dirname}/bunyan-api`).createLogger('delta');
const objectPath = require('object-path');
const yaml = require('js-yaml');
const fs = require('fs-extra');
const validUrl = require('valid-url');
const RequestLib = require('@razee/request-util');
const clone = require('clone');
const touch = require('touch');

const lastModified = {};

async function main() {
  let interval = process.env.ENFORCE_INTERVAL_MINUTES ? Number(process.env.ENFORCE_INTERVAL_MINUTES) * 60000 : 5 * 60000;

  let cont = true;
  do {
    await touch('/tmp/liveness');
    try {
      let resourceUris = [];
      let files = await fs.readdir(`${__dirname}/../resource-uris`);
      log.debug(`Found in dir ${JSON.stringify(files)}`);
      await Promise.all(files.map(async f => {
        if (f.startsWith('..')) {
          log.debug(`${f} is not a file ... skipping`);
          return;
        }

        let uri = await fs.readFile(`${__dirname}/../resource-uris/${f}`, { encoding: 'utf8' });
        uri = uri.trim();
        if (!validUrl.isUri(`${uri}`)) {
          log.error(`uri ${uri} not valid`);
        } else {
          resourceUris.push(uri);
        }
      }));
      log.debug(`Found uris ${JSON.stringify(resourceUris)}`);
      for (var i = 0; i < resourceUris.length; i++) {
        let uri = resourceUris[i];
        await update(uri);
      }
    } catch (e) {
      log.error(e);
    }
    await new Promise(resolve => { setTimeout(function () { resolve(); }, interval); });
  } while (cont);


}

async function update(uri) {
  log.info(`Updating ${uri}`);
  let file = await download(uri);
  file = yaml.loadAll(file);
  return decomposeFile(file);
}

async function download(uri) {
  log.debug(`Download ${uri}`);
  let aws;
  if (process.env.ACCESS_KEY_ID && process.env.SECRET_ACCESS_KEY) {
    aws = {
      key: process.env.ACCESS_KEY_ID,
      secret: process.env.SECRET_ACCESS_KEY,
      sign_version: 4
    };
  }
  let res = await RequestLib.doRequest({
    method: 'get',
    uri: uri,
    json: true,
    aws: aws,
    headers: {},
    simple: false,
    resolveWithFullResponse: true
  });
  if (res.statusCode >= 200 && res.statusCode < 300) {
    log.debug(`Download ${res.statusCode} ${uri}`);

    // let etag = objectPath.get(res, 'headers.etag');
    let lm = objectPath.get(res, 'headers.last-modified');
    // objectPath.set(lastModified, [uri, 'etag'], etag);
    objectPath.set(lastModified, [uri, 'last-modified'], lm);

    objectPath.set(lastModified, [uri, 'file'], res.body);
    return res.body;
  } else if (res.statusCode == 304) {
    log.debug(`Not Modified ${res.statusCode} ${uri}`);
    return objectPath.get(lastModified, [uri, 'file']);
  } else {
    return Promise.reject(res.body);
  }
}

async function decomposeFile(file) {
  let kind = objectPath.get(file, ['kind'], '');
  let apiVersion = objectPath.get(file, ['apiVersion'], '');
  let items = objectPath.get(file, ['items']);

  if (Array.isArray(file)) {
    return await Promise.all(file.map(async f => {
      return await decomposeFile(f);
    }));
  } else if (kind.toLowerCase() == 'list' && Array.isArray(items)) {
    return await Promise.all(items.map(async f => {
      return await decomposeFile(f);
    }));
  } else if (file) {
    let krm = await kc.getKubeResourceMeta(apiVersion, kind, 'update');
    let res;
    if (krm) {
      res = await apply(krm, file);
    } else {
      log.debug(`KubeResourceMeta not found for ${apiVersion}/${kind} ... skipping`);
    }
    return res;
  }
}

async function apply(krm, file, options = {}) {
  let name = objectPath.get(file, 'metadata.name');
  let namespace = objectPath.get(file, 'metadata.namespace', process.env.NAMESPACE);
  objectPath.set(file, 'metadata.namespace', namespace);
  let kind = objectPath.get(file, 'kind');
  let uri = krm.uri({ name: name, namespace: namespace });
  log.debug(`Apply ${uri}`);
  let opt = { simple: false, resolveWithFullResponse: true };
  let liveResource;
  let get = await krm.get(name, namespace, opt);
  if (get.statusCode === 200) {
    liveResource = objectPath.get(get, 'body');
    log.debug(`Get ${get.statusCode} ${uri}: resourceVersion ${objectPath.get(get, 'body.metadata.resourceVersion')}`);
  } else if (get.statusCode === 404) {
    log.debug(`Get ${get.statusCode} ${uri}`);
  } else {
    log.debug(`Get ${get.statusCode} ${uri}`);
    return Promise.reject({ statusCode: get.statusCode, body: get.body });
  }

  if (liveResource) {
    let lastApplied = objectPath.get(liveResource, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration']) ||
      objectPath.get(liveResource, ['metadata', 'annotations', 'kapitan.razee.io/last-applied-configuration']);
    if (!lastApplied) {
      log.warn(`${uri}: No deploy.razee.io/last-applied-configuration found`);
      objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration'], JSON.stringify(file));
    } else {
      lastApplied = JSON.parse(lastApplied);

      let original = clone(file);
      reconcileFields(file, lastApplied);
      objectPath.set(file, ['metadata', 'annotations', 'kapitan.razee.io/last-applied-configuration'], null);
      objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration'], JSON.stringify(original));
    }
    if (objectPath.get(options, 'mode', 'MergePatch').toLowerCase() == 'strategicmergepatch') {
      let res = await krm.strategicMergePatch(name, namespace, file, opt);
      log.debug(`strategicMergePatch ${res.statusCode} ${uri}`);
      if (res.statusCode === 415) {
        // let fall through
      } else if (res.statusCode < 200 || res.statusCode > 300) {
        return Promise.reject({ statusCode: res.statusCode, body: res.body });
      } else {
        log.info(`${kind}/${name} configured`);
        return { statusCode: res.statusCode, body: res.body };
      }
    }
    let res = await krm.mergePatch(name, namespace, file, opt);
    log.debug(`mergePatch ${res.statusCode} ${uri}`);
    if (res.statusCode < 200 || res.statusCode > 300) {
      return Promise.reject({ statusCode: res.statusCode, body: res.body });
    } else {
      log.info(`${kind}/${name} configured`);
      return { statusCode: res.statusCode, body: res.body };
    }
  } else {
    log.debug(`Post ${uri}`);
    let post = await krm.post(file, opt);
    if (!(post.statusCode === 200 || post.statusCode === 201 || post.statusCode === 202)) {
      log.debug(`Post ${post.statusCode} ${uri}`);
      return Promise.reject({ statusCode: post.statusCode, body: post.body });
    } else {
      log.info(`${kind}/${name} created`);
      return { statusCode: post.statusCode, body: post.body };
    }
  }
}

function reconcileFields(config, lastApplied, parentPath = []) {
  // Nulls fields that existed in deploy.razee.io/last-applied-configuration but not the new file to be applied
  // this has the effect of removing the field from the liveResource
  Object.keys(lastApplied).forEach(key => {
    let path = clone(parentPath);
    path.push(key);
    if (!objectPath.has(config, path)) {
      objectPath.set(config, path, null);
    } else if (typeof lastApplied[key] == 'object' && !Array.isArray(lastApplied[key])) {
      reconcileFields(config, lastApplied[key], path);
    }
  });
}

function createEventListeners() {
  process.on('SIGTERM', () => {
    log.info('recieved SIGTERM. not handling at this time.');
  });
  process.on('unhandledRejection', (reason) => {
    log.error('recieved unhandledRejection', reason);
  });
  process.on('beforeExit', (code) => {
    log.info(`No work found. exiting with code: ${code}`);
  });

}

async function run() {
  try {
    createEventListeners();

    await main();
  } catch (error) {
    log.error(error);
  }

}

module.exports = {
  run
};
