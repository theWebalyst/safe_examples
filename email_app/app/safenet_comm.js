import { shell } from 'electron';
import { CONSTANTS, MESSAGES, SAFE_APP_ERROR_CODES } from './constants';
import { initializeApp, fromAuthURI } from '@maidsafe/safe-node-app';
import { getAuthData, saveAuthData, clearAuthData, genRandomEntryKey,
         splitPublicIdAndService, deserialiseArray, parseUrl } from './utils/app_utils';
import pkg from '../package.json';

const APP_INFO = {
  info: {
    id: pkg.identifier,
    scope: null,
    name: pkg.productName,
    vendor: pkg.vendor
  },
  opts: {
    own_container: true
  },
  containers: {
    publicNames: '_publicNames'
  },
  permissions: {
    _publicNames: ['Read', 'Insert']
  }
};

const genServiceInfo = async (app, emailId) => {
  let serviceInfo = splitPublicIdAndService(emailId);
  const hashed = await app.crypto.sha3Hash(serviceInfo.publicId);
  serviceInfo.serviceAddr = hashed;
  return serviceInfo;
}

const requestShareMdAuth = async (app, mdPermissions) => {
  const resp = await app.auth.genShareMDataUri(mdPermissions);
  shell.openExternal(parseUrl(resp.uri));
  return null;
}

const requestAuth = async () => {
  const app = await initializeApp(APP_INFO.info);
  const resp = app.auth.genAuthUri(APP_INFO.permissions, APP_INFO.opts);
  shell.openExternal(parseUrl(resp.uri));
  return null;
}

export const authApp = (netStatusCallback) => {
  if (process.env.SAFE_FAKE_AUTH) {
    return initializeApp(APP_INFO.info)
      .then((app) => app.auth.loginForTest(APP_INFO.permissions));
  }

  let uri = getAuthData();
  if (uri) {
    return fromAuthURI(APP_INFO.info, uri, netStatusCallback)
      .then((registeredApp) => registeredApp.auth.refreshContainersPermissions()
        .then(() => registeredApp)
      )
      .catch((err) => {
        console.warn("Auth URI stored is not valid anymore, app needs to be re-authorised.");
        clearAuthData();
        return requestAuth();
      });
  }

  return requestAuth();
}

export const connect = async (uri, netStatusCallback) => {
  const registeredApp = await fromAuthURI(APP_INFO.info, uri, netStatusCallback);
  // synchronous
  saveAuthData(uri);
  await registeredApp.auth.refreshContainersPermissions();
  return registeredApp;
}

export const reconnect = (app) => {
  return app.reconnect();
}

const fetchPublicIds = (app) => {
  let rawEntries = [];
  let publicIds = [];
  return app.auth.getContainer(APP_INFO.containers.publicNames)
    .then((pubNamesMd) => pubNamesMd.getEntries()
      .then((entries) => entries.forEach((key, value) => {
          rawEntries.push({key, value});
        })
        .then(() => Promise.all(rawEntries.map((entry) => {
          if (entry.value.buf.length === 0) { //FIXME: this condition is a work around for a limitation in safe_core
            return Promise.resolve();
          }

          return pubNamesMd.decrypt(entry.key)
            .then((decKey) => {
              const id = decKey.toString();
              if (id === CONSTANTS.MD_META_KEY) { // Skip the metadata entry
                return Promise.resolve();
              }
              return pubNamesMd.decrypt(entry.value.buf)
                .then((service) => publicIds.push({ id, service }));
            });
        })))
      ))
    .then(() => publicIds);
}

export const fetchEmailIds = (app) => {
  let emailIds = [];

  return fetchPublicIds(app)
    .then((publicIds) => Promise.all(publicIds.map((publicId) => {
        let rawEmailIds = [];
        return app.mutableData.newPublic(publicId.service, CONSTANTS.TAG_TYPE_DNS)
            .then((servicesMd) => servicesMd.getKeys())
            .then((keys) => keys.forEach((key) => {
                rawEmailIds.push(key.toString());
              })
              .then(() => Promise.all(rawEmailIds.map((emailId) => {
                // Let's filter out the services which are not email services,
                // i.e. those which don't have the `@email` postfix.
                // This will filter out the MD metadata entry also.
                const regex = new RegExp('.*(?=' + CONSTANTS.SERVICE_NAME_POSTFIX +'$)', 'g');
                let res = regex.exec(emailId);
                if (res) {
                  emailIds.push(res[0] + ((res[0].length > 0) ? '.' : '') + publicId.id);
                }
              })))
            );
    })))
    .then(() => emailIds);
}

export const readConfig = async (app, emailId) => {
  let account = {id: emailId};

  const md = await app.auth.getOwnContainer();
  const value = await md.encryptKey(emailId).then((key) => md.get(key));
  const decrypted = await md.decrypt(value.buf);
  const storedAccount = JSON.parse(decrypted);
  const inboxMd = await app.mutableData.fromSerial(storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_INBOX]);
  account.inboxMd = inboxMd;
  const archiveMd = await app.mutableData.fromSerial(storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ARCHIVE]);
  account.archiveMd = archiveMd;
  account.encSk = storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_SECRET_KEY];
  account.encPk = storedAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_PUBLIC_KEY]
  return account;
}

const insertEncrypted = async (md, mut, key, value) => {
  const encryptedKey = await md.encryptKey(key);
  const encryptedValue = await md.encryptValue(value);
  return mut.insert(encryptedKey, encryptedValue);
}

export const writeConfig = async (app, account) => {
  let emailAccount = {
    [CONSTANTS.ACCOUNT_KEY_EMAIL_ID]: account.id,
    [CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_SECRET_KEY]: account.encSk,
    [CONSTANTS.ACCOUNT_KEY_EMAIL_ENC_PUBLIC_KEY]: account.encPk
  };

  const serialisedInbox = await account.inboxMd.serialise();
  emailAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_INBOX] = serialisedInbox;
  const serialisedArchive = await account.archiveMd.serialise();
  emailAccount[CONSTANTS.ACCOUNT_KEY_EMAIL_ARCHIVE] = serialisedArchive;
  const md = await app.auth.getOwnContainer();
  const mut = await app.mutableData.newMutation();
  await insertEncrypted(md, mut, account.id, JSON.stringify(emailAccount));
  await md.applyEntriesMutation(mut);
  return account;
}

const decryptEmail = async (app, account, key, value, cb) => {
  if (value.length > 0) { //FIXME: this condition is a work around for a limitation in safe_core
    const entryValue = await decrypt(app, value, account.encSk, account.encPk);
    const immData = await app.immutableData.fetch(deserialiseArray(entryValue));
    const content = await immData.read();
    const decryptedEmail = await decrypt(app, content, account.encSk, account.encPk);
    return cb({ id: key, email: JSON.parse(decryptedEmail) });
  }
}

export const readInboxEmails = async (app, account, cb) => {
  const entries = await account.inboxMd.getEntries();
  await entries.forEach((key, value) => {
    if (key.toString() !== CONSTANTS.MD_KEY_EMAIL_ENC_PUBLIC_KEY) {
      return decryptEmail(app, account, key, value.buf, cb);
    }
  });
  return entries.len();
}

export const readArchivedEmails = async (app, account, cb) => {
  const entries = await account.archiveMd.getEntries();
  await entries.forEach((key, value) => {
    return decryptEmail(app, account, key, value.buf, cb);
  })
}

const createInbox = async (app, encPk) => {
  let baseInbox = {
    [CONSTANTS.MD_KEY_EMAIL_ENC_PUBLIC_KEY]: encPk
  };

  const inboxMd = await app.mutableData.newRandomPublic(CONSTANTS.TAG_TYPE_INBOX)
  await inboxMd.quickSetup(baseInbox);
  const permSet = await app.mutableData.newPermissionSet();
  await permSet.setAllow('Insert');
  await inboxMd.setUserPermissions(null, permSet, 1);
  return inboxMd;
}

const createArchive = async (app) => {
  const md = await app.mutableData.newRandomPrivate(CONSTANTS.TAG_TYPE_EMAIL_ARCHIVE)
  return md.quickSetup();
}

const createPublicIdAndEmailService = async (
  app, pubNamesMd, serviceInfo, inboxSerialised
) => {
  const metadata = {
    ...CONSTANTS.SERVICE_METADATA,
    name: `${CONSTANTS.SERVICE_METADATA.name}: '${serviceInfo.publicId}'`,
    description: `${CONSTANTS.SERVICE_METADATA.description}: '${serviceInfo.publicId}'`
  };

  const md = await app.mutableData.newPublic(serviceInfo.serviceAddr, CONSTANTS.TAG_TYPE_DNS)
  await md.quickSetup(
    { [serviceInfo.serviceName]: inboxSerialised }, metadata.name, metadata.description
  );
  const mut = await app.mutableData.newMutation();
  await insertEncrypted(pubNamesMd, mut, serviceInfo.publicId, serviceInfo.serviceAddr);
  return pubNamesMd.applyEntriesMutation(mut);
}

const genNewAccount = (app, id) => {
  let inboxMd;
  return genKeyPair(app)
    .then((keyPair) => createInbox(app, keyPair.publicKey)
      .then((md) => inboxMd = md)
      .then(() => createArchive(app))
      .then((archiveMd) => ({id, inboxMd, archiveMd,
                            encSk: keyPair.privateKey,
                            encPk: keyPair.publicKey}))
    );
}

const registerEmailService = async (app, serviceToRegister) => {
  const newAccount = await genNewAccount(app, serviceToRegister.emailId);
  const inboxSerialised = await newAccount.inboxMd.serialise();
  const md = await app.mutableData.newPublic(serviceToRegister.servicesXorName, CONSTANTS.TAG_TYPE_DNS);
  const mut = await app.mutableData.newMutation();
  await mut.insert(serviceToRegister.serviceName, inboxSerialised);
  await md.applyEntriesMutation(mut);
  return newAccount;
}

export const createEmailService = (app, servicesXorName, serviceInfo) => {
  const emailService = {
    servicesXorName,
    emailId: serviceInfo.emailId,
    serviceName: serviceInfo.serviceName
  };

  return app.crypto.getAppPubSignKey()
    .then((appSignKey) => app.mutableData.newPublic(servicesXorName, CONSTANTS.TAG_TYPE_DNS)
      .then((md) => md.getUserPermissions(appSignKey)) // FIXME: the permissions it has could not be enough
      .then(() => registerEmailService(app, emailService).then((newAccount) => ({ newAccount }))
        , (err) => requestShareMdAuth(app,
            [{ type_tag: CONSTANTS.TAG_TYPE_DNS,
               name: servicesXorName,
               perms: ['Insert']
             }] )
          .then(() => emailService)
      ));
}

export const setupAccount = (app, emailId) => {
  let serviceInfo;
  return genServiceInfo(app, emailId)
    .then((info) => serviceInfo = info)
    .then(() => app.auth.getContainer(APP_INFO.containers.publicNames))
    .then((pubNamesMd) => pubNamesMd.encryptKey(serviceInfo.publicId).then((key) => pubNamesMd.get(key))
      // If service container already exists, try to add email service
      .then((encryptedAddr) => pubNamesMd.decrypt(encryptedAddr.buf)
        .then((servicesXorName) => createEmailService(app, servicesXorName, serviceInfo))
      , (err) => { // ...if not then create it
        if (err.code !== SAFE_APP_ERROR_CODES.ERR_NO_SUCH_ENTRY) {
          throw err;
        }
        // The public ID doesn't exist in _publicNames
        return genNewAccount(app, serviceInfo.emailId)
          .then((newAccount) => newAccount.inboxMd.serialise()
            .then((inboxSerialised) => createPublicIdAndEmailService(app,
                                pubNamesMd, serviceInfo, inboxSerialised))
            .then(() => ({ newAccount }))
          )
      })
    );
}

export const connectWithSharedMd = async (app, uri, serviceToRegister) => {
  await app.auth.loginFromURI(uri);
  await app.auth.refreshContainersPermissions();
  return registerEmailService(app, serviceToRegister);
}

const writeEmailContent = async (app, email, pk) => {
  const encryptedEmail = await encrypt(app, JSON.stringify(email), pk);
  const emailWriter = await app.immutableData.create();
  await emailWriter.write(encryptedEmail);
  const cipherOpt = await app.cipherOpt.newPlainText();
  return emailWriter.close(cipherOpt);
}

export const storeEmail = (app, email, to) => {
  let serviceInfo;
  return genServiceInfo(app, to)
    .then((info) => serviceInfo = info)
    .then(() => app.mutableData.newPublic(serviceInfo.serviceAddr, CONSTANTS.TAG_TYPE_DNS))
    .then((md) => md.get(serviceInfo.serviceName))
    .catch((err) => {throw MESSAGES.EMAIL_ID_NOT_FOUND})
    .then((service) => app.mutableData.fromSerial(service.buf))
    .then((inboxMd) => inboxMd.get(CONSTANTS.MD_KEY_EMAIL_ENC_PUBLIC_KEY)
      .then((pk) => writeEmailContent(app, email, pk.buf.toString())
        .then((emailAddr) => app.mutableData.newMutation()
          .then((mut) => {
            let entryKey = genRandomEntryKey();
            return encrypt(app, emailAddr, pk.buf.toString())
              .then(entryValue => mut.insert(entryKey, entryValue)
                .then(() => inboxMd.applyEntriesMutation(mut))
              )
          })
        )));
}

export const removeEmail = (app, container, key) => {
  return app.mutableData.newMutation()
    .then((mut) => mut.remove(key, 1)
      .then(() => container.applyEntriesMutation(mut))
    )
}

export const archiveEmail = (app, account, key) => {
  let newEntryKey = genRandomEntryKey();
  return account.inboxMd.get(key)
    .then((xorName) => app.mutableData.newMutation()
      .then((mut) => mut.insert(newEntryKey, xorName.buf)
        .then(() => account.archiveMd.applyEntriesMutation(mut))
      )
    )
    .then(() => app.mutableData.newMutation())
    .then((mut) => mut.remove(key, 1)
      .then(() => account.inboxMd.applyEntriesMutation(mut))
    )
}

const genKeyPair = (app) => {
  let rawKeyPair = {};
  return app.crypto.generateEncKeyPair()
    .then(keyPair => keyPair.pubEncKey.getRaw()
      .then(rawPubEncKey => {
        rawKeyPair.publicKey = rawPubEncKey.buffer.toString('hex');
        return;
      })
      .then(() => keyPair.secEncKey.getRaw())
      .then(rawSecEncKey => {
        rawKeyPair.privateKey = rawSecEncKey.buffer.toString('hex');
        return rawKeyPair;
      })
    )
}

const encrypt = (app, input, pk) => {
  if(Array.isArray(input)) {
    input = input.toString();
  }

  let stringToBuffer = Buffer.from(pk, 'hex');

  return app.crypto.pubEncKeyKeyFromRaw(stringToBuffer)
    .then(pubEncKeyAPI => pubEncKeyAPI.encryptSealed(input))
};

const decrypt = (app, cipherMsg, sk, pk) => {
  return app.crypto.generateEncKeyPairFromRaw(Buffer.from(pk, 'hex'), Buffer.from(sk, 'hex'))
    .then(keyPair => keyPair.decryptSealed(cipherMsg))
    .then((decrypted) => decrypted.toString())
};
