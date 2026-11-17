import admin from 'firebase-admin';

let firestore = null;
let authMode = 'sqlite-fallback';
const FIREBASE_TIMEOUT_MS = 8000;
const withTimeout = (operation, label) => Promise.race([
  operation,
  new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${FIREBASE_TIMEOUT_MS / 1000} seconds`)), FIREBASE_TIMEOUT_MS))
]);
let serviceAccountJson = null;
try { serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON) : null; }
catch { console.warn('FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON; Firebase is disabled until it is corrected.'); }
const hasServiceAccountKey = Boolean(serviceAccountJson || (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_CLIENT_EMAIL && process.env.FIREBASE_PRIVATE_KEY));
// Application Default Credentials work on Google Cloud or a local gcloud session,
// but are not automatically available in Render. Opt in explicitly when present.
const hasApplicationDefaultCredentials = process.env.FIREBASE_USE_APPLICATION_DEFAULT === 'true';

if (hasServiceAccountKey || hasApplicationDefaultCredentials) {
  try {
    const credential = hasServiceAccountKey
      ? admin.credential.cert(serviceAccountJson || {
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
        })
      : admin.credential.applicationDefault();
    admin.initializeApp({
      credential,
      projectId: process.env.FIREBASE_PROJECT_ID,
      storageBucket: process.env.FIREBASE_STORAGE_BUCKET || undefined
    });
    firestore = admin.firestore();
    authMode = hasServiceAccountKey ? (serviceAccountJson ? 'service-account-json' : 'service-account-key') : 'application-default-credentials';
    console.log(`Firebase Firestore enabled via ${authMode}`);
  } catch (error) {
    console.warn(`Firebase disabled: ${error.message}`);
  }
} else {
  console.log('Firebase service credentials not configured; using local SQLite fallback');
}

export const firebaseEnabled = () => Boolean(firestore);
export const firebaseInfo = () => ({ enabled: Boolean(firestore), provider: firestore ? 'firestore' : 'sqlite-fallback', auth: authMode, projectId: process.env.FIREBASE_PROJECT_ID || null });

export async function firebaseGet(collection, id) {
  if (!firestore) return null;
  const snapshot = await withTimeout(firestore.collection(collection).doc(String(id)).get(), `Firestore read for ${collection}/${id}`);
  return snapshot.exists ? { id: snapshot.id, ...snapshot.data() } : null;
}

export async function firebaseList(collection) {
  if (!firestore) return [];
  const snapshot = await withTimeout(firestore.collection(collection).get(), `Firestore read for ${collection}`);
  return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
}

export async function firebaseUpsert(collection, id, data) {
  if (!firestore) return;
  try { await withTimeout(firestore.collection(collection).doc(String(id)).set({ ...data, syncedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true }), `Firestore write for ${collection}/${id}`); }
  catch (error) { console.warn(`Firebase write skipped: ${error.message}`); }
}

export async function firebaseDelete(collection, id) {
  if (!firestore) return;
  try { await withTimeout(firestore.collection(collection).doc(String(id)).delete(), `Firestore delete for ${collection}/${id}`); }
  catch (error) { console.warn(`Firebase delete skipped: ${error.message}`); }
}

export async function firebaseFindUserByEmail(email) {
  if (!firestore) return null;
  const snapshot = await firestore.collection('users').where('email', '==', email.toLowerCase()).limit(1).get();
  if (snapshot.empty) return null;
  return { id: snapshot.docs[0].id, ...snapshot.docs[0].data() };
}
