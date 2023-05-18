/**
 * Copyright 2022, 2023 IBM Corp. All Rights Reserved.
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

const log = require(`${__dirname}/bunyan-api`).createLogger('razeeupdate');
const argv = require('minimist')(process.argv.slice(2));
const validUrl = require('valid-url');
const axios = require('axios');
const { KubeClass } = require('@razee/kubernetes-util');
const kc = new KubeClass();
const yaml = require('js-yaml');
const clone = require('clone');
const objectPath = require('object-path');
const handlebars = require('handlebars');

const { purgeDeprecatedResources, removeDeprecatedResources } = require('./remove');

var success = true;
const argvNamespace = typeof (argv.n || argv.namespace) === 'string' ? argv.n || argv.namespace : 'razeedeploy';

async function main() {
  let fileSource = typeof (argv.s || argv['file-source']) === 'string' ? argv.s || argv['file-source'] : 'https://github.com/razee-io';
  if (!validUrl.isUri(fileSource)) {
    success = false;
    return log.error(`'${fileSource}' not a valid source url.`);
  } else if (fileSource.endsWith('/')) {
    fileSource = fileSource.replace(/\/+$/g, '');
  }

  let filePath = typeof (argv['fp'] || argv['file-path']) === 'string' ? argv['fp'] || argv['file-path'] : 'releases/{{install_version}}/resource.yaml';

  let resourcesObj = {
    'watchkeeper': { install: argv.wk || argv['watchkeeper'] || argv['watch-keeper'], uri: `${fileSource}/WatchKeeper/${filePath}` },
    'clustersubscription': { install: argv.cs || argv['clustersubscription'], uri: `${fileSource}/ClusterSubscription/${filePath}` },
    'remoteresource': { install: argv.rr || argv['remoteresource'], uri: `${fileSource}/RemoteResource/${filePath}` },
    'mustachetemplate': { install: argv.mtp || argv['mustachetemplate'], uri: `${fileSource}/MustacheTemplate/${filePath}` },
  };

  // Handle deprecated resources
  // Handle deprecated resources
  purgeDeprecatedResources( resourcesObj );
  await removeDeprecatedResources( argvNamespace ); // No force, default retries and timeouts

  let resourceUris = Object.values(resourcesObj);
  let installAll = resourceUris.reduce((shouldInstallAll, currentValue) => {
    return objectPath.get(currentValue, 'install') === undefined ? shouldInstallAll : false;
  }, true);

  for (var i = 0; i < resourceUris.length; i++) {
    if (installAll || resourceUris[i].install) {
      let file = await download(resourceUris[i]);
      file = readYaml(file.data);
      await decomposeFile(file);
    }
  }
}

async function download(resourceUriObj) {
  let install_version = (typeof resourceUriObj.install === 'string' && resourceUriObj.install.toLowerCase() !== 'latest') ? `download/${resourceUriObj.install}` : 'latest/download';
  if (argv['fp'] || argv['file-path']) {
    // if file-path is defined, use the version directly
    install_version = `${resourceUriObj.install}`;
  }
  let uri = resourceUriObj.uri.replace('{{install_version}}', install_version);
  try {
    log.info(`Downloading ${uri}`);
    return await axios.get(uri);
  } catch (e) {
    let latestUri = resourceUriObj.uri.replace('{{install_version}}', (argv['fp'] || argv['file-path']) ? 'latest' : 'latest/download');
    log.warn(`Failed to download ${uri}.. defaulting to ${latestUri}`);
    return await axios.get(latestUri);
  }
}

function readYaml(file) {
  let yamlTemplate = handlebars.compile(file);
  let templatedJson = yaml.loadAll(yamlTemplate());
  return templatedJson[0];
}

async function decomposeFile(file) {
  const fileApiVersion = objectPath.get(file, 'apiVersion');
  const fileKind = objectPath.get(file, 'kind');

  if (fileApiVersion.toLowerCase() === 'v1' && fileKind.toLowerCase() === 'list' && Array.isArray(file.items)) {
    try {
      let res = await Promise.all(file.items.map(async item => {
        let applyFileRes = await decomposeFile(item);
        if (!applyFileRes.statusCode || applyFileRes.statusCode < 200 || applyFileRes.statusCode >= 300) {
          return Promise.reject(applyFileRes);
        }
        return applyFileRes;
      }));
      return res[0];
    } catch (e) {
      return e;
    }
  }

  let krm = await kc.getKubeResourceMeta(fileApiVersion, fileKind, 'update');

  let res;
  try {
    res = await apply(krm, file);
  } catch (e) {
    res = e;
  }
  return res;
}

function reconcileFields(config, lastApplied, parentPath = []) {
  // Nulls fields that existed in deploy.razee.io/last-applied-configuration but not the new file to be applied
  // this has the effect of removing the field from the liveResource
  Object.keys(lastApplied).forEach(key => {
    let path = clone(parentPath);
    path.push(key);
    const configPathValue = objectPath.get(config, path);
    // if config does not have the lastApplied path, make sure to set lastApplied path in config to null.
    // we must avoid nulling any "objects", and only nulling "leafs", as we could delete other fields unintentionally.
    if (configPathValue === undefined && lastApplied[key] !== undefined && lastApplied[key] !== null && lastApplied[key].constructor !== Object) {
      objectPath.set(config, path, null);
      // elseif lastApplied[key] is not null/undefined, and it is an object, and configPathValue is not already set null by user, then we should recurse
    } else if ((lastApplied[key] && lastApplied[key].constructor === Object && configPathValue !== null)) {
      reconcileFields(config, lastApplied[key], path);
    } // else path exists both in lastApplied and new config, no need to alter it
  });
}

async function apply(krm, file) {
  let name = objectPath.get(file, 'metadata.name');
  let namespace = argvNamespace;
  let uri = krm.uri({ name: objectPath.get(file, 'metadata.name'), namespace: namespace });
  const additiveMergPatchWarning = 'AdditiveMergePatch - Skipping reconcileFields from last-applied.';
  log.debug(`Apply ${uri}`);
  let opt = { simple: false, resolveWithFullResponse: true };
  let liveResource;
  let get = await krm.get(name, namespace, opt);
  if (get.statusCode === 200) {
    liveResource = objectPath.get(get, 'body');
    log.debug(`Get ${get.statusCode} ${uri}: resourceVersion ${objectPath.get(get, 'body.metadata.resourceVersion')}`);
  } else if (get.statusCode === 404) {
    log.debug(`Get ${get.statusCode} ${uri} Not an attached cluster, operators should not be updated.`); //don't apply if operator doesn't already exist
  } else if (get.statusCode === 403) {
    log.debug(`Get ${get.statusCode} ${uri} Missing authorization, not an attached cluster. Operators should not be applied.`); //don't apply if service account doesn't have authorization
  }
  else {
    log.debug(`Get ${get.statusCode} ${uri}`);
    return Promise.reject({ statusCode: get.statusCode, body: get.body });
  }

  if (liveResource) {
    let debug = objectPath.get(liveResource, ['metadata', 'labels', 'deploy.razee.io/debug'], 'false');
    if (debug.toLowerCase() === 'true') {
      log.warn(`${uri}: Debug enabled on resource: skipping modifying resource - adding annotation deploy.razee.io/pending-configuration.`);
      let patchObject = { metadata: { annotations: { 'deploy.razee.io/pending-configuration': JSON.stringify(file) } } };
      let res = await krm.mergePatch(name, namespace, patchObject);
      return { statusCode: 200, body: res };
    } else {
      let pendingApply = objectPath.get(liveResource, ['metadata', 'annotations', 'deploy.razee.io/pending-configuration']);
      if (objectPath.get(file, ['metadata', 'annotations']) === null) {
        objectPath.set(file, ['metadata', 'annotations'], {});
      }
      if (pendingApply) {
        objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/pending-configuration'], null);
      }
    }
    // ensure annotations is not null before we start working with it
    if (objectPath.get(file, ['metadata', 'annotations']) === null) {
      objectPath.set(file, ['metadata', 'annotations'], {});
    }
    let lastApplied = objectPath.get(liveResource, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration']);
    if (!lastApplied || lastApplied == additiveMergPatchWarning) {
      log.warn(`${uri}: No deploy.razee.io/last-applied-configuration found`);
      objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration'], JSON.stringify(file));
    } else {
      lastApplied = JSON.parse(lastApplied);

      let original = clone(file);
      reconcileFields(file, lastApplied);
      // If reconcileFields set annotations to null, make sure its an empty object instead
      if (objectPath.get(file, ['metadata', 'annotations']) === null) {
        objectPath.set(file, ['metadata', 'annotations'], {});
      }
      objectPath.set(file, ['metadata', 'annotations', 'deploy.razee.io/last-applied-configuration'], JSON.stringify(original));
    }
    // mode: MergePatch or AdditiveMergePatch
    let res = await krm.mergePatch(name, namespace, file, opt);
    log.debug(`MergePatch ${res.statusCode} ${uri}`);
    if (res.statusCode < 200 || res.statusCode >= 300) {
      success = false;
      return Promise.reject({ statusCode: res.statusCode, body: res.body });
    } else {
      return { statusCode: res.statusCode, body: res.body };
    }
  }
}

async function run() {
  try {
    await main();
    success === true ? process.exit(0) : process.exit(1);
  } catch (error) {
    log.error(error);
    process.exit(1);
  }
}

module.exports = {
  run
};
