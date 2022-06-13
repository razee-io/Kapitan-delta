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

const log = require(`${__dirname}/bunyan-api`).createLogger('razeedeploy-install');
const argv = require('minimist')(process.argv.slice(2));
const validUrl = require('valid-url');

log.debug(`Running Install with args: ${JSON.stringify(argv)}`);

const { KubeClass } = require('@razee/kubernetes-util');
const kc = new KubeClass();

const objectPath = require('object-path');
const yaml = require('js-yaml');
const fs = require('fs-extra');
const axios = require('axios');
const handlebars = require('handlebars');
const forge = require('node-forge');

var success = true;
const argvNamespace = typeof (argv.n || argv.namespace) === 'string' ? argv.n || argv.namespace : 'razeedeploy';

async function main() {
  if (argv.h || argv.help) {
    log.info(`
-h, --help
    : help menu
-d, --debug=''
    : loop to keep the pod running. Does not attempt install (Default 5 minutes)
-n, --namespace=''
    : namespace to populate razeedeploy resources into (Default 'razeedeploy')
-s, --file-source=''
    : url that razeedeploy-job should source razeedeploy resource files from (Default 'https://github.com/razee-io')
--fp, --file-path=''
    : the path directly after each component, e.g. \${fileSource}/WatchKeeper/\${filePath}. (Default 'releases/{{install_version}}/resource.yaml')
-r, --registry=''
    : image registry that razeedeploy-job should install razeedeploy images with (Default 'quay.io/razee/')
--wk, --watchkeeper='', --watch-keeper=''
    : install watchkeeper at a specific version (Default 'latest')
--cs, --clustersubscription=''
    : install clustersubscription at a specific version (Default 'latest')
--rd-url, --razeedash-url=''
    : url that watchkeeper should post data to (Default '\${--razeedash-api}/api/v2' if provided)
--rd-api, --razeedash-api=''
    : razee api baseUrl (Default '\${--razeedash-url}.origin' if provided)
--rd-org-key, --razeedash-org-key=''
    : org key used to authenticate with razee
--rd-cluster-id, --razeedash-cluster-id=''
    : cluster id to be used as the cluster id in RazeeDash (Default 'namespace.metadata.uid')
--rd-cluster-metadata64, --razeedash-cluster-metadata64=''
    : base64 encoded JSON object of cluster metadata entries {key: value, ...}. To be stored into watch-keeper-cluster-metadata ConfigMap and sent to RazeeDash
--rr, --remoteresource=''
    : install remoteresource at a specific version (Default 'latest')
--rrs3, --remoteresources3=''
    : install remoteresources3 at a specific version (Default 'latest')
--rrs3d, --remoteresources3decrypt=''
    : install remoteresources3decrypt at a specific version (Default 'latest')
--mtp, --mustachetemplate=''
    : install mustachetemplate at a specific version (Default 'latest')
--iw, --impersonationwebhook=''
    : install impersonation webhook at a specific version (Default 'latest'). When remote resource controller and/or mustache template controller are installed, this webhook will be installed even if this flag is not set
--ffsld, --featureflagsetld=''
    : install featureflagsetld at a specific version (Default 'latest')
--er, --encryptedresource=''
    : install encryptedresource at a specific version (Default 'latest')
--ms, --managedset=''
    : install managedset at a specific version (Default 'latest')
-f, --force
    : overwrite prerequisite configuration already installed on the cluster (Default false)
-a, --autoupdate
    : will create a remoteresource that will pull and keep specified resources updated to latest (even if a version was specified). if no resources specified, will do all known resources.
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

  let filePath = typeof (argv['fp'] || argv['file-path']) === 'string' ? argv['fp'] || argv['file-path'] : 'releases/{{install_version}}/resource.yaml';

  let rdUrl = argv['rd-url'] || argv['razeedash-url'] || false;
  if (rdUrl && !validUrl.isUri(rdUrl)) {
    log.warn(`razeedash-url '${rdUrl}' is not a valid url.`);
  } else if (rdUrl) {
    rdUrl = new URL(rdUrl);
  }
  let rdApi = argv['rd-api'] || argv['razeedash-api'] || false;
  if (rdApi && !validUrl.isUri(rdApi)) {
    log.warn(`razeedash-api '${rdApi}' not a valid url.`);
  } else if (rdApi) {
    rdApi = new URL(rdApi);
  }
  let rdOrgKey = argv['rd-org-key'] || argv['razeedash-org-key'] || false;
  let rdclusterId = argv['rd-cluster-id'] || argv['razeedash-cluster-id'] || false;
  let rdclusterMetadata = [];
  const base64String = argv['rd-cluster-metadata64'] || argv['razeedash-cluster-metadata64'];
  try {
    if (base64String) {
      const buff = new Buffer.from(base64String, 'base64');
      const valuesString = buff.toString('utf8');
      const values = JSON.parse(valuesString);
      for (var [name, value] of Object.entries(values)) {
        if (typeof value === 'object') {
          value = JSON.stringify(value);
        }
        rdclusterMetadata.push({ name, value });
      }
      log.debug(`rdclusterMetadata is ${JSON.stringify(rdclusterMetadata)}`);
    }
  } catch (exception) {
    log.warn(`can not decode or parse json object from razeedash-cluster-metadata ${base64String}`);
  }
  let applyMode = (argv.f || argv['force']) !== undefined && ((argv.f || argv['force']) === true || (argv.f || argv['force']).toLowerCase() === 'true') ? 'replace' : 'ensureExists';


  let autoUpdate = argv.a || argv.autoupdate || false;
  let autoUpdateArray = [];

  let resourcesObj = {
    'watchkeeper': { install: argv.wk || argv['watchkeeper'] || argv['watch-keeper'], uri: `${fileSource}/WatchKeeper/${filePath}` },
    'clustersubscription': { install: argv.cs || argv['clustersubscription'], uri: `${fileSource}/ClusterSubscription/${filePath}` },
    'remoteresource': { install: argv.rr || argv['remoteresource'], uri: `${fileSource}/RemoteResource/${filePath}` },
    'remoteresources3': { install: argv.rrs3 || argv['remoteresources3'], uri: `${fileSource}/RemoteResourceS3/${filePath}` },
    'remoteresources3decrypt': { install: argv.rrs3d || argv['remoteresources3decrypt'], uri: `${fileSource}/RemoteResourceS3Decrypt/${filePath}` },
    'mustachetemplate': { install: argv.mtp || argv['mustachetemplate'], uri: `${fileSource}/MustacheTemplate/${filePath}` },
    'featureflagsetld': { install: argv.ffsld || argv['featureflagsetld'], uri: `${fileSource}/FeatureFlagSetLD/${filePath}` },
    'encryptedresource': { install: argv.er || argv['encryptedresource'], uri: `${fileSource}/EncryptedResource/${filePath}` },
    'managedset': { install: argv.ms || argv['managedset'], uri: `${fileSource}/ManagedSet/${filePath}` },
    'impersonationwebhook': { install: argv.iw || argv['impersonationwebhook'], uri: `${fileSource}/ImpersonationWebhook/${filePath}` }
  };

  try {
    log.info('=========== Installing Prerequisites ===========');
    let preReqsJson = await readYaml(`${__dirname}/resources/preReqs.yaml`, { desired_namespace: argvNamespace });
    await decomposeFile(preReqsJson, applyMode);
    await createRazeeConfig(argvNamespace, applyMode);

    let resourceUris = Object.values(resourcesObj);
    let resources = Object.keys(resourcesObj);
    let installAll = resourceUris.reduce((shouldInstallAll, currentValue) => {
      return objectPath.get(currentValue, 'install') === undefined ? shouldInstallAll : false;
    }, true);

    if (installAll || resourcesObj['clustersubscription'].install || resourcesObj['watchkeeper'].install) {
      if (!rdApi && !rdUrl) log.warn('Failed to find arg \'--razeedash-api\' or \'--razeedash-url\'.. will create template \'razee-identity\' config.');
      if (!rdOrgKey) log.warn('Failed to find arg\'--razeedash-org-key\'.. will create template \'razee-identity\' secret.');
      let ridConfigJson = await readYaml(`${__dirname}/resources/ridConfig.yaml`, {
        desired_namespace: argvNamespace,
        razeedash_api: rdApi.href || rdUrl.origin || 'insert-rd-url-here',
        razeedash_cluster_id: rdclusterId ? { id: rdclusterId } : false, // have set to false, {} puts any "" string value
        razeedash_org_key: Buffer.from(rdOrgKey || 'api-key-youorgkeyhere').toString('base64')
      });
      await decomposeFile(ridConfigJson, applyMode);
    }

    if (!installAll && (objectPath.get(resourcesObj, 'remoteresource.install') || objectPath.get(resourcesObj, 'mustachetemplate.install'))) {
      if (!objectPath.get(resourcesObj, "impersonationwebhook.install")) {
        objectPath.set(resourcesObj, "impersonationwebhook.install", true);
      }
    }

    for (var i = 0; i < resourceUris.length; i++) {
      if (installAll || resourceUris[i].install) {
        log.info(`=========== Installing ${resources[i]}:${resourceUris[i].install || 'Install All Resources'} ===========`);
        if (resources[i] === 'watchkeeper') {
          let wkConfigJson = await readYaml(`${__dirname}/resources/wkConfig.yaml`, {
            desired_namespace: argvNamespace,
            razeedash_url: rdUrl.href ? { url: rdUrl.href } : false,
            razeedash_cluster_metadata: rdclusterMetadata,
          });
          await decomposeFile(wkConfigJson, applyMode);
        } else if (resources[i] === 'clustersubscription') {
          if (!(installAll || resourcesObj.remoteresource.install)) {
            log.warn('RemoteResource CRD must be one of the installed resources in order to use ClusterSubscription. (ie. --rr --cs).. Skipping ClusterSubscription');
            continue;
          }
        }

        let certPem = '';
        if (resources[i] === 'impersonationwebhook') {
          certPem = await createWebhookSecret(argvNamespace, applyMode);
        }

        let { file } = await download(resourceUris[i]);
        file = yaml.loadAll(file);

        await decomposeFile(file);

        // webhook config is created after the webhook is installed.
        if (resources[i] === 'impersonationwebhook') {
          await createWebhookConfig(certPem, argvNamespace, applyMode);
        }

        if (autoUpdate) {
          autoUpdateArray.push({ options: { url: resourceUris[i].uri.replace('{{install_version}}', (argv['fp'] || argv['file-path']) ? 'latest' : 'latest/download') } });
        }
      }
    }

    if (autoUpdate && (installAll || resourcesObj.remoteresource.install)) { // remoteresource must be installed to use autoUpdate
      log.info('=========== Installing Auto-Update RemoteResource ===========');
      let autoUpdateJson = await readYaml(`${__dirname}/resources/autoUpdateRR.yaml`, { desired_namespace: argvNamespace });
      objectPath.set(autoUpdateJson, '0.spec.requests', autoUpdateArray);
      try {
        await crdRegistered('deploy.razee.io/v1alpha2', 'RemoteResource');
        await decomposeFile(autoUpdateJson);
      } catch (e) {
        success = false;
        log.error(`${e}.. skipping autoUpdate`);
      }
    } else if (autoUpdate && !(installAll || resourcesObj.remoteresource.install)) {
      log.info('=========== Installing Auto-Update RemoteResource ===========');
      log.warn('RemoteResource CRD must be one of the installed resources in order to use autoUpdate. (ie. --rr -a).. Skipping autoUpdate');
    }
  } catch (e) {
    success = false;
    log.error(e);
  }
}

async function createWebhookSecret(namespace, applyMode) {
  let pki = forge.pki;
  let keys = pki.rsa.generateKeyPair(2048);
  let cert = pki.createCertificate();

  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();

  let expirationDate = new Date();
  expirationDate.setFullYear(expirationDate.getFullYear() + 10);
  cert.validity.notAfter = expirationDate;

  let attrs = [{
    name: 'commonName',
    value: `impersonation-webhook.${namespace}.svc`
  }];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    {
      name: 'basicConstraints',
      cA: true
    },
    {
      name: 'subjectKeyIdentifier'
    },
    {
      name: 'subjectAltName',
      altNames: [{
        type: 6,
        value: `impersonation-webhook.${namespace}.svc`
      }]
    }]);

  cert.sign(keys.privateKey, forge.md.sha256.create());

  let certPem = pki.certificateToPem(cert);
  let privatekeyPem = pki.privateKeyToPem(keys.privateKey);
  let webhookSecretJson = await readYaml(`${__dirname}/resources/webhookSecret.yaml`, {
    desired_namespace: namespace,
    webhook_ca: Buffer.from(certPem).toString('base64'),
    webhook_cert: Buffer.from(certPem).toString('base64'),
    webhook_key: Buffer.from(privatekeyPem).toString('base64'),
  });

  await decomposeFile(webhookSecretJson, applyMode);

  return certPem;
}

async function createWebhookConfig(certPem, namespace, applyMode) {
  let webhookConfigJson = await readYaml(`${__dirname}/resources/webhookConfig.yaml`, {
    desired_namespace: namespace,
    webhook_ca: Buffer.from(certPem).toString('base64')
  });

  await decomposeFile(webhookConfigJson, applyMode);
}

async function createRazeeConfig(namespace, applyMode) {
  let razeeConfigJson = await readYaml(`${__dirname}/resources/razeeConfig.yaml`, {
    desired_namespace: namespace
  });

  await decomposeFile(razeeConfigJson, applyMode);
}

async function readYaml(path, templateOptions = {}) {
  let yamlFile = await fs.readFile(path, 'utf8');
  let yamlTemplate = handlebars.compile(yamlFile);
  let templatedJson = yaml.loadAll(yamlTemplate(templateOptions));
  return templatedJson;
}

const pause = (duration) => new Promise(res => setTimeout(res, duration));

async function crdRegistered(apiVersion, kind, attempts = 5, backoffInterval = 50) {
  let krm = (await kc.getKubeResourceMeta(apiVersion, kind, 'get'));
  let krmExists = krm ? true : false;
  if (krmExists) {
    log.info(`Found ${apiVersion} ${kind}`);
    return krm;
  } else if (--attempts <= 0) {
    success = false;
    throw Error(`Failed to find ${apiVersion} ${kind}`);
  } else {
    log.warn(`Did not find ${apiVersion} ${kind}.. attempts remaining: ${attempts}`);
    await pause(backoffInterval);
    return crdRegistered(apiVersion, kind, attempts, backoffInterval * 2);
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

async function decomposeFile(file, mode = 'replace') {
  let kind = objectPath.get(file, ['kind'], '');
  let apiVersion = objectPath.get(file, ['apiVersion'], '');
  let items = objectPath.get(file, ['items']);

  if (Array.isArray(file)) {
    for (let i = 0; i < file.length; i++) {
      await decomposeFile(file[i], mode);
    }
  } else if (kind.toLowerCase() == 'list' && Array.isArray(items)) {
    for (let i = 0; i < items.length; i++) {
      await decomposeFile(items[i], mode);
    }
  } else if (file) {
    let krm = await kc.getKubeResourceMeta(apiVersion, kind, 'update');
    if (krm) {
      let registrySub = typeof (argv['r'] || argv['registry']) === 'string' ? argv['r'] || argv['registry'] : undefined;
      if (registrySub !== undefined) {
        const deployContainers = objectPath.get(file, 'spec.template.spec.containers', []);
        deployContainers.forEach(container => {
          const image = objectPath.get(container, 'image');
          if (image !== undefined) {
            if (!registrySub.endsWith('/')) registrySub = `${registrySub}/`;
            objectPath.set(container, 'image', image.replace('quay.io/razee/', registrySub));
          }
        });
      }

      if (!objectPath.has(file, 'metadata.namespace') && krm.namespaced) {
        log.info(`No namespace found for ${kind} ${objectPath.get(file, 'metadata.name')}.. setting namespace: ${argvNamespace}`);
        objectPath.set(file, 'metadata.namespace', argvNamespace);
      }
      try {
        if (mode === 'ensureExists') {
          await ensureExists(krm, file);
        } else {
          await replace(krm, file);
        }
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

async function replace(krm, file, options = {}) {
  let name = objectPath.get(file, 'metadata.name');
  let namespace = objectPath.get(file, 'metadata.namespace');
  let uri = krm.uri({ name: name, namespace: namespace, status: options.status });
  log.info(`Replace ${uri}`);
  let response = {};
  let opt = { simple: false, resolveWithFullResponse: true };
  let liveMetadata;
  log.info(`- Get ${uri}`);
  let get = await krm.get(name, namespace, opt);
  if (get.statusCode === 200) {
    liveMetadata = objectPath.get(get, 'body.metadata');
    log.info(`- Get ${get.statusCode} ${uri}: resourceVersion ${objectPath.get(get, 'body.metadata.resourceVersion')}`);
  } else if (get.statusCode === 404) {
    log.info(`- Get ${get.statusCode} ${uri}`);
  } else {
    log.info(`- Get ${get.statusCode} ${uri}`);
    return Promise.reject({ statusCode: get.statusCode, body: get.body });
  }

  if (liveMetadata) {
    objectPath.set(file, 'metadata.resourceVersion', objectPath.get(liveMetadata, 'resourceVersion'));

    log.info(`- Put ${uri}`);
    let put = await krm.put(file, opt);
    if (!(put.statusCode === 200 || put.statusCode === 201)) {
      log.info(`- Put ${put.statusCode} ${uri}`);
      return Promise.reject({ statusCode: put.statusCode, body: put.body });
    } else {
      log.info(`- Put ${put.statusCode} ${uri}`);
      response = { statusCode: put.statusCode, body: put.body };
    }
  } else {
    log.info(`- Post ${uri}`);
    let post = await krm.post(file, opt);
    if (!(post.statusCode === 200 || post.statusCode === 201 || post.statusCode === 202)) {
      log.info(`- Post ${post.statusCode} ${uri}`);
      return Promise.reject({ statusCode: post.statusCode, body: post.body });
    } else {
      log.info(`- Post ${post.statusCode} ${uri}`);
      response = { statusCode: post.statusCode, body: post.body };
    }
  }
  return response;
}

async function ensureExists(krm, file, options = {}) {
  let name = objectPath.get(file, 'metadata.name');
  let namespace = objectPath.get(file, 'metadata.namespace');
  let uri = krm.uri({ name: name, namespace: namespace, status: options.status });
  log.info(`EnsureExists ${uri}`);
  let response = {};
  let opt = { simple: false, resolveWithFullResponse: true };

  let get = await krm.get(name, namespace, opt);
  if (get.statusCode === 200) {
    log.info(`- Get ${get.statusCode} ${uri}`);
    return { statusCode: get.statusCode, body: get.body };
  } else if (get.statusCode === 404) { // not found -> must create
    log.info(`- Get ${get.statusCode} ${uri}`);
  } else {
    log.info(`- Get ${get.statusCode} ${uri}`);
    return Promise.reject({ statusCode: get.statusCode, body: get.body });
  }

  log.info(`- Post ${uri}`);
  let post = await krm.post(file, opt);
  if (post.statusCode === 200 || post.statusCode === 201 || post.statusCode === 202) {
    log.info(`- Post ${post.statusCode} ${uri}`);
    return { statusCode: post.statusCode, body: post.body };
  } else if (post.statusCode === 409) { // already exists
    log.info(`- Post ${post.statusCode} ${uri}`);
    response = { statusCode: 200, body: post.body };
  } else {
    log.info(`- Post ${post.statusCode} ${uri}`);
    return Promise.reject({ statusCode: post.statusCode, body: post.body });
  }
  return response;
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
