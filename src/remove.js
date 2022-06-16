/**
 * Copyright 2020 IBM Corp. All Rights Reserved.
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

const log = require(`${__dirname}/bunyan-api`).createLogger('razeedeploy-remove');
const argv = require('minimist')(process.argv.slice(2));
const validUrl = require('valid-url');

const { KubeClass } = require('@razee/kubernetes-util');
const kc = new KubeClass();

const objectPath = require('object-path');
const yaml = require('js-yaml');
const fs = require('fs-extra');
const axios = require('axios');
const handlebars = require('handlebars');

var success = true;
const argvNamespace = typeof (argv.n || argv.namespace) === 'string' ? argv.n || argv.namespace : 'razeedeploy';

async function main() {
  if (argv.h || argv.help) {
    log.info(`
-h, --help
    : help menu
-d, --debug=''
    : loop to keep the pod running. Does not attempt removal (Default 5 minutes)
-n, --namespace=''
    : namespace to remove razeedeploy resources from (Default 'razeedeploy')
--dn, --delete-namespace=''
    : include namespace as a resource to delete (Default false)
-s, --file-source=''
    : url that razeedeploy-job should source razeedeploy resource files from (Default 'https://github.com/razee-io')
--fp, --file-path=''
: the path directly after each component, e.g. \${fileSource}/WatchKeeper/\${filePath}. (Default 'releases/{{install_version}}/resource.yaml')
-t, --timeout
    : time (minutes) before failing to delete CRD (Default 5)
-a, --attempts
    : number of attempts to verify CRD is deleted before failing (Default 5)
-f, --force
    : force delete the CRD and CR instances without allowing the controller to clean up children (Default false)
    `);
    return;
  } else if (argv.d || argv.debug) {
    let debugTimerMinutes = typeof (argv.d || argv['debug']) === 'number' ? argv.d || argv['debug'] : 5;
    let debugTimerSeconds = debugTimerMinutes * 60;
    log.info(`Debug will run for ${Math.floor(debugTimerSeconds / 60)}m ${(debugTimerSeconds % 60)}s.`);

    let timeleft = debugTimerSeconds;
    while (timeleft > 0) {
      if (timeleft >= 300) {
        log.info(`Exiting in ${Math.floor(timeleft / 60)}m ${(timeleft % 60)}s`);
        timeleft -= 30;
        await new Promise(resolve => setTimeout(() => resolve(), 30000));
      } else if (timeleft > 60) {
        log.info(`Exiting in ${Math.floor(timeleft / 60)}m ${(timeleft % 60)}s`);
        timeleft -= 10;
        await new Promise(resolve => setTimeout(() => resolve(), 10000));
      } else {
        log.info(`Exiting in ${timeleft}s`);
        timeleft -= 1;
        await new Promise(resolve => setTimeout(() => resolve(), 1000));
      }
    }
    return;
  }

  let fileSource = typeof (argv.s || argv['file-source']) === 'string' ? argv.s || argv['file-source'] : 'https://github.com/razee-io';
  if (!validUrl.isUri(fileSource)) {
    success = false;
    return log.error(`'${fileSource}' not a valid source url.`);
  } else if (fileSource.endsWith('/')) {
    fileSource = fileSource.replace(/\/+$/g, '');
  }

  let filePath = argv['fp'] || argv['file-path'] || 'releases/{{install_version}}/resource.yaml';

  let resourcesObj = {
    'watchkeeper': { remove: argv.wk || argv['watchkeeper'] || argv['watch-keeper'], uri: `${fileSource}/WatchKeeper/${filePath}` },
    'clustersubscription': { remove: argv.cs || argv['clustersubscription'], uri: `${fileSource}/ClusterSubscription/${filePath}` },
    'remoteresource': { remove: argv.rr || argv['remoteresource'], uri: `${fileSource}/RemoteResource/${filePath}` },
    'remoteresources3': { remove: argv.rrs3 || argv['remoteresources3'], uri: `${fileSource}/RemoteResourceS3/${filePath}` },
    'remoteresources3decrypt': { remove: argv.rrs3d || argv['remoteresources3decrypt'], uri: `${fileSource}/RemoteResourceS3Decrypt/${filePath}` },
    'mustachetemplate': { remove: argv.mtp || argv['mustachetemplate'], uri: `${fileSource}/MustacheTemplate/${filePath}` },
    'featureflagsetld': { remove: argv.ffsld || argv['featureflagsetld'], uri: `${fileSource}/FeatureFlagSetLD/${filePath}` },
    'encryptedresource': { remove: argv.er || argv['encryptedresource'], uri: `${fileSource}/EncryptedResource/${filePath}` },
    'managedset': { remove: argv.ms || argv['managedset'], uri: `${fileSource}/ManagedSet/${filePath}` },
    'impersonationwebhook' : { remove: argv.iw || argv['impersonationwebhook'], uri: `${fileSource}/ImpersonationWebhook/${filePath}` }
  };

  let dltNamespace = typeof (argv.dn || argv['delete-namespace']) === 'boolean' ? argv.dn || argv['delete-namespace'] : false;
  let force = typeof (argv.f || argv['force']) === 'boolean' ? argv.f || argv['force'] : false;

  let attempts = typeof (argv.a || argv.attempts) === 'number' ? argv.a || argv.attempts : 5;
  let timeout = typeof (argv.t || argv.timeout) === 'number' ? argv.t || argv.timeout : 5;
  let timeoutMillSec = timeout * 60 * 1000;
  let backoff = Math.floor(timeoutMillSec / Math.pow(2, attempts - 1));

  try {
    let resourceUris = Object.values(resourcesObj);
    let resources = Object.keys(resourcesObj);
    let removeAll = resourceUris.reduce((shouldInstallAll, currentValue) => {
      return objectPath.get(currentValue, 'remove') === undefined ? shouldInstallAll : false;
    }, true);

    for (let i = 0; i < resourceUris.length; i++) {
      if (removeAll || resourceUris[i].remove) {
        log.info(`=========== Removing ${resources[i]}:${resourceUris[i].remove || 'Remove All Resources'} ===========`);
        if (resources[i] === 'watchkeeper') {
          let wkConfigJson = await readYaml(`${__dirname}/resources/wkConfig.yaml`, { desired_namespace: argvNamespace });
          await deleteFile(wkConfigJson);
        }
        if (resources[i] === 'impersonationwebhook') {
          let webhookConfigJson = await readYaml(`${__dirname}/resources/webhookConfig.yaml`, { desired_namespace: argvNamespace });
          await deleteFile(webhookConfigJson);
        }
        let { file } = await download(resourceUris[i]);
        file = yaml.loadAll(file);
        let flatFile = flatten(file);
        let crdIndex = flatFile.findIndex((el) => objectPath.get(el, 'kind') === 'CustomResourceDefinition');
        if (crdIndex >= 0) {
          let crd = flatFile.splice(crdIndex, 1)[0];
          try {
            await deleteFile(crd);
            if (force) {
              await forceCleanupCR(crd);
            } else {
              await crdDeleted(objectPath.get(crd, 'metadata.name'), attempts, backoff);
            }
          } catch (e) {
            success = false;
            log.error(`Timed out trying to safely clean up crd ${objectPath.get(crd, 'metadata.name')}.. use option '-f, --force' to force clean up (note: child resources wont be cleaned up)`);
          }
        }
        await deleteFile(flatFile);
      }
    }

    log.info('=========== Removing Prerequisites ===========');
    let preReqsJson = await readYaml(`${__dirname}/resources/preReqs.yaml`, { desired_namespace: argvNamespace });
    for (let i = 0; i < preReqsJson.length; i++) {
      let preReq = preReqsJson[i];
      let kind = objectPath.get(preReq, 'kind');
      if ((kind.toLowerCase() !== 'namespace') || (kind.toLowerCase() === 'namespace' && dltNamespace)) {
        await deleteFile(preReq);
      } else {
        log.info(`Skipping namespace deletion: --namespace='${argvNamespace}' --delete-namespace='${dltNamespace}'`);
      }
    }
    if (removeAll || (resourcesObj['clustersubscription'].remove && resourcesObj['watch-keeper'].remove)) {
      // if watch-keeper and clustersubscription are removed in seperate runs, ridConfig will be left on the cluster
      let ridConfigJson = await readYaml(`${__dirname}/resources/ridConfig.yaml`, { desired_namespace: argvNamespace });
      await deleteFile(ridConfigJson);
    }
    if (removeAll || (resourcesObj['impersonationwebhook'].remove)) {
      let webhookSecretJson = await readYaml(`${__dirname}/resources/webhookSecret.yaml`, { desired_namespace: argvNamespace });
      await deleteFile(webhookSecretJson);
    }

  } catch (e) {
    success = false;
    log.error(e);
  }
}

async function readYaml(path, templateOptions = {}) {
  let yamlFile = await fs.readFile(path, 'utf8');
  let yamlTemplate = handlebars.compile(yamlFile);
  let templatedJson = yaml.loadAll(yamlTemplate(templateOptions));
  return templatedJson;
}

async function forceCleanupCR(crd) {
  let group = objectPath.get(crd, 'spec.group', 'deploy.razee.io');
  let versions = objectPath.get(crd, 'spec.versions', []);
  let kind = objectPath.get(crd, 'spec.names.kind', '');

  for (let i = 0; i < versions.length; i++) {
    let apiVersion = `${group}/${versions[i].name}`;
    let krm = versions[i].storage ? await kc.getKubeResourceMeta(apiVersion, kind, 'get') : undefined;
    if (krm) {
      let crs = await krm.get();
      await deleteFile(crs, true);
    }
  }
}

const pause = (duration) => new Promise(res => setTimeout(res, duration));

async function crdDeleted(name, attempts = 5, backoffInterval = 3750) {
  let krm = await kc.getKubeResourceMeta('apiextensions.k8s.io/v1beta1', 'CustomResourceDefinition', 'get');
  let crdDltd = (await krm.get(name, undefined, { simple: false, resolveWithFullResponse: true })).statusCode === 404 ? true : false;
  if (crdDltd) {
    log.info(`Successfully deleted ${name}`);
    return;
  } else if (--attempts <= 0) {
    success = false;
    throw Error(`Failed to delete ${name}`);
  } else {
    log.warn(`CRD ${name} not fully removed.. re-checking in: ${backoffInterval / 1000} sec, attempts remaining: ${attempts}`);
    await pause(backoffInterval);
    return crdDeleted(name, attempts, backoffInterval * 2);
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
    return { file: (await axios.get(uri)).data, uri: uri };
  } catch (e) {
    let latestUri = resourceUriObj.uri.replace('{{install_version}}', (argv['fp'] || argv['file-path']) ? 'latest' : 'latest/download');
    log.warn(`Failed to download ${uri}.. defaulting to ${latestUri}`);
    return { file: (await axios.get(latestUri)).data, uri: latestUri };
  }
}

function flatten(file) {
  return file.reduce((result, current) => {
    let kind = objectPath.get(current, ['kind'], '');
    let items = objectPath.get(current, ['items']);

    if (Array.isArray(current)) {
      return result.concat(flatten(current));
    } else if (kind.toLowerCase().endsWith('list') && Array.isArray(items)) {
      return result.concat(flatten(items));
    } else {
      return result.concat(current);
    }
  }, []);
}

async function deleteFile(file, force = false) {
  let kind = objectPath.get(file, ['kind'], '');
  let apiVersion = objectPath.get(file, ['apiVersion'], '');
  let items = objectPath.get(file, ['items']);

  if (Array.isArray(file)) {
    for (let i = 0; i < file.length; i++) {
      await deleteFile(file[i], force);
    }
  } else if (kind.toLowerCase().endsWith('list') && Array.isArray(items)) {
    for (let i = 0; i < items.length; i++) {
      await deleteFile(items[i], force);
    }
  } else if (file) {
    let krm = await kc.getKubeResourceMeta(apiVersion, kind, 'delete');
    if (krm) {
      if (!objectPath.has(file, 'metadata.namespace') && krm.namespaced) {
        log.info(`No namespace found for ${kind} ${objectPath.get(file, 'metadata.name')}.. setting namespace: ${argvNamespace}`);
        objectPath.set(file, 'metadata.namespace', argvNamespace);
      }
      try {
        await deleteResource(krm, file, { force: force });
      } catch (e) {
        success = false;
        log.error(e);
      }
    } else {
      success = false;
      log.error(`KubeResourceMeta not found: { kind: ${kind}, apiVersion: ${apiVersion}, name: ${objectPath.get(file, 'metadata.name')}, namespace: ${objectPath.get(file, 'metadata.namespace')} } ... skipping`);
    }
  }
}

async function deleteResource(krm, file, options = {}) {
  let name = objectPath.get(file, 'metadata.name');
  let namespace = objectPath.get(file, 'metadata.namespace');
  let uri = krm.uri({ name: name, namespace: namespace, status: options.status });
  log.info(`Delete ${uri}`);
  let opt = { simple: false, resolveWithFullResponse: true };

  if (options.force) {
    let mrgPtch = await krm.mergePatch(name, namespace, { metadata: { finalizers: null } }, opt);
    if (mrgPtch.statusCode === 200) {
      log.info(`- MergePatch ${mrgPtch.statusCode} ${uri}`);
    } else if (mrgPtch.statusCode === 404) { // not found -> already gone
      log.info(`- MergePatch ${mrgPtch.statusCode} ${uri}`);
      return { statusCode: mrgPtch.statusCode, body: mrgPtch.body };
    } else {
      log.info(`- MergePatch ${mrgPtch.statusCode} ${uri}`);
      return Promise.reject({ statusCode: mrgPtch.statusCode, body: mrgPtch.body });
    }
  }

  let dlt = await krm.delete(name, namespace, opt);
  if (dlt.statusCode === 200) {
    log.info(`- Delete ${dlt.statusCode} ${uri}`);
    return { statusCode: dlt.statusCode, body: dlt.body };
  } else if (dlt.statusCode === 404) { // not found -> already gone
    log.info(`- Delete ${dlt.statusCode} ${uri}`);
    return { statusCode: dlt.statusCode, body: dlt.body };
  } else {
    log.info(`- Delete ${dlt.statusCode} ${uri}`);
    return Promise.reject({ statusCode: dlt.statusCode, body: dlt.body });
  }
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
    success === true ? process.exit(0) : process.exit(1);
  } catch (error) {
    log.error(error);
    process.exit(1);
  }

}

module.exports = {
  run
};
