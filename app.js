    const STORAGE_KEY = "territorioSeguro.v1";
    const MIGRATION_KEY = "territorioSeguro.migratedToFirebase";
    const riskNames = { high: "Alto riesgo", medium: "Riesgo medio", safe: "Seguro" };
    const inspectionTypeIcons = {
      "evaluación de riesgo": "⚠",
      "inundación": "🌊",
      "deslizamiento": "⛰",
      "incendio": "🔥",
      "infraestructura": "🏗",
      "evacuación": "🚶",
      "materiales peligrosos": "☣",
      "servicios básicos": "🔧",
      "otro": "📍"
    };
    const apureMunicipalityColors = {
      "Achaguas": "#e76f51",
      "Biruaca": "#277da1",
      "Muñoz": "#43aa8b",
      "Páez": "#9b5de5",
      "Pedro Camejo": "#f9c74f",
      "Rómulo Gallegos": "#f15bb5",
      "San Fernando": "#577590"
    };
    const monthNames = ["Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio", "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre"];
    const apureMunicipalitiesUrl = "./apure-municipalities.geojson";
    const MAP_MAX_ZOOM = 17;
    const apureReferencePlaces = [{ name: "Sede Protección Civil Regional", category: "Protección Civil", address: "Perimetral Sur, María Nieves, San Fernando, Apure", latitude: 7.8703637, longitude: -67.4820609 }];
    const INITIAL_ADMIN_UID = window.TERRITORIO_INITIAL_ADMIN_UID;
    let firebaseAuth = null;
    let firebaseDatabase = null;
    let firebaseInitializationError = "";
    let activeAuthUid = null;
    let profileListener = null;
    let sharedDataListener = null;
    let profilesListener = null;
    let invitationsListener = null;
    let pendingProfileDraft = null;
    let authFlowPending = false;
    let migrationAttempted = false;
    let cloudCollectionKeys = { inspections: [], referencePlaces: [] };
    let cloudCollectionData = { inspections: {}, referencePlaces: {} };
    let sharedDataReady = false;
    let sharedDataLoadError = "";
    let sharedDataDiagnostic = "";
    let state = loadState();
    let currentUser = null;
    let map = null;
    let mapZoomAnchor = null;
    let selectedMapDate = "";
    let mapDateWindowOffset = 0;
    let mapToolsManuallyToggled = false;
    let inspectionPlaceLookupId = 0;
    let inspectionTitleEdited = false;
    let inspectionAddressEdited = false;
    let baseLayer = null;
    let apureMunicipalityFeatures = [];
    let apureMunicipalityLayer = null;
    let apureMunicipalityLabelLayer = null;
    let apureMunicipalityLoadPromise = null;
    let referenceLayers = [];
    let currentMapLayer = "satellite";
    let markers = [];
    let referenceMarkers = [];
    let editingInspectionId = null;
    let editingPlaceId = null;
    let pickLocationMode = false;
    let mapPickTarget = null;
    let pendingMapLocation = null;
    let pointChoicePopup = null;
    let pendingLocationMarker = null;
    let calendarMonth = new Date();
    let recordsCalendarMonth = new Date();
    let recordsYear = new Date().getFullYear();
    let recordsMonth = null;
    let toastTimer;

    try {
      if (!window.firebase || !window.TERRITORIO_FIREBASE_CONFIG) throw new Error("No se pudo cargar la configuración de Firebase.");
      const firebaseApp = firebase.apps.length ? firebase.app() : firebase.initializeApp(window.TERRITORIO_FIREBASE_CONFIG);
      firebaseAuth = firebase.auth(firebaseApp);
      firebaseDatabase = firebase.database(firebaseApp);
    } catch (error) {
      firebaseInitializationError = error.message || "No se pudo inicializar Firebase.";
      console.error(firebaseInitializationError, error);
    }

    function loadState() {
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY));
        if (stored && Array.isArray(stored.users) && Array.isArray(stored.inspections)) {
          if (!Array.isArray(stored.invitations)) stored.invitations = [];
          if (!Array.isArray(stored.referencePlaces)) stored.referencePlaces = [];
          return stored;
        }
      } catch (error) { console.warn("No se pudieron leer los datos locales", error); }
      return { users: [], invitations: [], inspections: [], referencePlaces: [] };
    }
    function saveState({ referencePlacesFirst = false } = {}) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      if (!currentUser || !firebaseDatabase || activeAuthUid !== currentUser.id) return Promise.resolve(false);
      if (!sharedDataReady) {
        showToast("Los datos todavía se están cargando. Espera un momento e inténtalo de nuevo.");
        return Promise.resolve(false);
      }
      const sync = referencePlacesFirst
        ? syncCloudCollection("referencePlaces", state.referencePlaces).then(() => syncCloudCollection("inspections", state.inspections))
        : Promise.all([
          syncCloudCollection("inspections", state.inspections),
          syncCloudCollection("referencePlaces", state.referencePlaces)
        ]);
      return sync.then(() => true).catch(error => {
        console.error("No se pudieron sincronizar los cambios con Firebase.", error);
        showToast(`Firebase rechazó el guardado${error.code ? ` (${error.code})` : ""}. Revisa permisos y conexión.`);
        return false;
      });
    }
    async function syncCloudCollection(name, records) {
      const collection = firebaseDatabase.ref(`territorioSeguro/shared/${name}`);
      const currentRecords = Object.fromEntries(records.map(record => [String(record.id), record]));
      const currentKeys = new Set(Object.keys(currentRecords));
      const previousData = cloudCollectionData[name];
      const previousKeys = cloudCollectionKeys[name];
      const operations = Object.entries(currentRecords)
        .filter(([id, record]) => JSON.stringify(record) !== JSON.stringify(previousData[id]))
        .map(([id, record]) => collection.child(id).set(record));
      previousKeys.filter(id => !currentKeys.has(id)).forEach(id => operations.push(collection.child(id).remove()));
      await Promise.all(operations);
      cloudCollectionKeys[name] = Array.from(currentKeys);
      cloudCollectionData[name] = currentRecords;
    }
    function escapeHtml(value = "") {
      return String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    }
    function showAuth() {
      document.getElementById("authScreen").classList.remove("hidden");
      document.getElementById("app").classList.add("hidden");
      if (!firebaseAuth || !firebaseDatabase) {
        document.getElementById("authBox").innerHTML = `<h2>Servicio no disponible</h2><p>${escapeHtml(firebaseInitializationError || "Configura Firebase antes de iniciar sesión.")}</p>`;
        return;
      }
      renderLogin();
    }
    function renderSetup() {
      let savedDraft = null;
      try { savedDraft = JSON.parse(localStorage.getItem("territorioSeguro.adminDraft") || "null"); } catch (error) { console.error("No se pudo leer la configuración inicial guardada.", error); }
      if (savedDraft && INITIAL_ADMIN_UID === "REEMPLAZAR_CON_UID_DEL_ADMIN") {
        document.getElementById("authBox").innerHTML = `<h2>Termina la configuración</h2><p>Copia este UID en <code>firebase-config.js</code> y en <code>database.rules.json</code>; luego publica las reglas seguras.</p><p><code>${escapeHtml(savedDraft.uid)}</code></p><button class="button" id="returnToLogin">Volver al inicio</button>`;
        document.getElementById("returnToLogin").addEventListener("click", () => renderLogin());
        return;
      }
      document.getElementById("authBox").innerHTML = `<h2>Crear cuenta administradora</h2><p>Registra la cuenta inicial autorizada para administrar el mapa.</p>
        <form class="form-stack" id="setupForm"><div class="field"><label for="setupName">Nombre del administrador</label><input id="setupName" required maxlength="100" autocomplete="name"></div>
        <div class="field"><label for="setupEmail">Correo electrónico</label><input id="setupEmail" required type="email" autocomplete="email"></div>
        <div class="field"><label for="setupPassword">Contraseña (mínimo 8 caracteres)</label><input id="setupPassword" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="message" id="authMessage"></div><button class="button" type="submit">Crear administrador</button></form>
        <div class="local-note">El administrador inicial requiere el UID autorizado en firebase-config.js y database.rules.json.</div>`;
      document.getElementById("setupForm").addEventListener("submit", async event => {
        event.preventDefault();
        const message = document.getElementById("authMessage");
        const email = document.getElementById("setupEmail").value.trim().toLowerCase();
        authFlowPending = true;
        let keepAuthFlowPending = false;
        try {
          const credential = await firebaseAuth.createUserWithEmailAndPassword(email, document.getElementById("setupPassword").value);
          pendingProfileDraft = { uid: credential.user.uid, name: document.getElementById("setupName").value.trim(), email, role: "admin" };
          localStorage.setItem("territorioSeguro.adminDraft", JSON.stringify(pendingProfileDraft));
          keepAuthFlowPending = true;
          message.innerHTML = `Cuenta creada. Copia este UID: <code>${escapeHtml(credential.user.uid)}</code>. Pégalo en <code>firebase-config.js</code> y en <code>database.rules.json</code>, publica las reglas seguras y luego inicia sesión.`;
        } catch (error) {
          message.textContent = friendlyAuthError(error);
          console.error("No se pudo crear la cuenta administradora.", error);
        } finally {
          if (!keepAuthFlowPending) authFlowPending = false;
        }
      });
    }
    function renderLogin(message = "") {
      document.getElementById("authBox").innerHTML = `<h2>Iniciar sesión</h2><p>Ingresa a tu espacio de coordinación.</p>
        <form class="form-stack" id="loginForm"><div class="field"><label for="loginEmail">Correo electrónico</label><input id="loginEmail" required type="email" autocomplete="username"></div>
        <div class="field"><label for="loginPassword">Contraseña</label><input id="loginPassword" type="password" required autocomplete="current-password"></div>
        <div class="message" id="authMessage">${escapeHtml(message)}</div><button class="button" type="submit">Entrar</button></form>
        <div class="auth-switch"><button class="text-button" id="resetPassword">¿Olvidaste tu contraseña?</button></div>
        <div class="auth-switch">¿Tienes una invitación? <button class="text-button" id="showRegister">Solicitar acceso</button></div>
        ${INITIAL_ADMIN_UID && INITIAL_ADMIN_UID !== "REEMPLAZAR_CON_UID_DEL_ADMIN" ? "" : `<div class="auth-switch"><button class="text-button" id="showSetup">Crear administrador inicial</button></div>`}
        <div class="local-note">La sincronización estará disponible al publicar las reglas seguras de Firebase.</div>`;
      document.getElementById("loginForm").addEventListener("submit", async event => {
        event.preventDefault();
        const message = document.getElementById("authMessage");
        try {
          await firebaseAuth.signInWithEmailAndPassword(document.getElementById("loginEmail").value.trim(), document.getElementById("loginPassword").value);
        } catch (error) {
          message.textContent = friendlyAuthError(error);
          console.error("No se pudo iniciar sesión.", error);
        }
      });
      document.getElementById("resetPassword").addEventListener("click", async () => {
        const email = document.getElementById("loginEmail").value.trim();
        const message = document.getElementById("authMessage");
        if (!email) { message.textContent = "Escribe tu correo electrónico para enviarte el enlace de recuperación."; return; }
        try {
          await firebaseAuth.sendPasswordResetEmail(email);
          message.textContent = "Si el correo está registrado, recibirás un enlace para restablecer la contraseña.";
        } catch (error) {
          message.textContent = friendlyAuthError(error);
          console.error("No se pudo enviar el enlace de recuperación.", error);
        }
      });
      document.getElementById("showRegister").addEventListener("click", renderRegister);
      const setupButton = document.getElementById("showSetup");
      if (setupButton) setupButton.addEventListener("click", renderSetup);
    }
    function renderRegister(message = "") {
      document.getElementById("authBox").innerHTML = `<h2>Solicitar acceso</h2><p>Registra tus datos con el código de invitación que recibiste.</p>
        <form class="form-stack" id="registerForm"><div class="field"><label for="registerName">Nombre completo</label><input id="registerName" required maxlength="100" autocomplete="name"></div>
        <div class="field"><label for="registerCedula">Cédula de identidad</label><input id="registerCedula" required maxlength="20" autocomplete="off" placeholder="Ej. V-12345678"></div>
        <div class="field"><label for="registerPhone">Teléfono de contacto</label><input id="registerPhone" required maxlength="30" type="tel" autocomplete="tel"></div>
        <div class="field"><label for="registerOrganizationType">Organización</label><select id="registerOrganizationType" required><option value="">Selecciona tu organización</option><option>Protección Civil</option><option>9-1-1</option><option>Bomberos</option><option>Otro</option></select></div>
        <div class="field hidden" id="registerOtherOrganizationField"><label for="registerOtherOrganization">Especifica la organización</label><input id="registerOtherOrganization" maxlength="100"></div>
        <div class="field"><label for="registerHierarchy">Jerarquía, cargo o rango</label><input id="registerHierarchy" required maxlength="100" placeholder="Ej. Inspector, sargento, coordinador"></div>
        <div class="field"><label for="registerEmail">Correo electrónico</label><input id="registerEmail" required type="email" autocomplete="email"></div>
        <div class="field"><label for="registerInvite">Código de invitación</label><input id="registerInvite" required maxlength="30" class="mono"></div>
        <div class="field"><label for="registerPassword">Clave (mínimo 8 caracteres)</label><input id="registerPassword" type="password" required minlength="8" autocomplete="new-password"></div>
        <div class="message" id="authMessage">${escapeHtml(message)}</div><button class="button" type="submit">Enviar solicitud</button></form>
        <div class="auth-switch">¿Ya tienes una cuenta? <button class="text-button" id="showLogin">Iniciar sesión</button></div>
        <div class="local-note">Necesitas un código de invitación. El administrador aprobará tu solicitud antes de que puedas ingresar.</div>`;
      document.getElementById("registerForm").addEventListener("submit", async event => {
        event.preventDefault();
        const code = document.getElementById("registerInvite").value.trim().toUpperCase();
        const message = document.getElementById("authMessage");
        let newUser = null;
        let invitationRef = null;
        let invitationClaimed = false;
        let profileSaved = false;
        authFlowPending = true;
        try {
          const email = document.getElementById("registerEmail").value.trim().toLowerCase();
          const organizationType = document.getElementById("registerOrganizationType").value;
          const organization = organizationType === "Otro"
            ? document.getElementById("registerOtherOrganization").value.trim()
            : organizationType;
          const credential = await firebaseAuth.createUserWithEmailAndPassword(email, document.getElementById("registerPassword").value);
          newUser = credential.user;
          invitationRef = firebaseDatabase.ref(`territorioSeguro/invitations/${code}`);
          const invitationSnapshot = await invitationRef.once("value");
          const invitation = invitationSnapshot.val();
          if (!invitation || invitation.used || invitation.expiresAt && invitation.expiresAt < Date.now()) {
            await credential.user.delete();
            await firebaseAuth.signOut();
            renderRegister("El código no es válido o ya fue utilizado.");
            return;
          }
          const profile = {
            name: document.getElementById("registerName").value.trim(),
            email: credential.user.email,
            phone: document.getElementById("registerPhone").value.trim(),
            cedula: document.getElementById("registerCedula").value.trim(),
            organization,
            organizationType,
            hierarchy: document.getElementById("registerHierarchy").value.trim(),
            invitationCode: code,
            role: "user",
            status: "pending",
            createdAt: new Date().toISOString()
          };
          await invitationRef.update({ used: true, usedBy: credential.user.uid });
          invitationClaimed = true;
          await firebaseDatabase.ref(`territorioSeguro/profiles/${credential.user.uid}`).set(profile);
          profileSaved = true;
          pendingProfileDraft = null;
          await firebaseAuth.signOut();
          renderLogin("Solicitud enviada. El administrador revisará tu cuenta antes de habilitar el acceso.");
        } catch (error) {
          let cleanupFailed = false;
          if (newUser && !profileSaved) {
            try {
              if (invitationClaimed) await invitationRef.update({ used: false, usedBy: null });
              await newUser.delete();
              await firebaseAuth.signOut();
            } catch (cleanupError) {
              cleanupFailed = true;
              console.error("No se pudo revertir la solicitud incompleta.", cleanupError);
            }
          }
          message.textContent = `${friendlyAuthError(error)}${cleanupFailed ? " La solicitud pudo quedar parcialmente creada; contacta al administrador." : ""}`;
          console.error("No se pudo enviar la solicitud de acceso.", error);
        } finally {
          authFlowPending = false;
        }
      });
      document.getElementById("registerOrganizationType").addEventListener("change", event => {
        const otherField = document.getElementById("registerOtherOrganizationField");
        const otherInput = document.getElementById("registerOtherOrganization");
        const isOther = event.target.value === "Otro";
        otherField.classList.toggle("hidden", !isOther);
        otherInput.required = isOther;
        if (!isOther) otherInput.value = "";
      });
      document.getElementById("showLogin").addEventListener("click", () => renderLogin());
    }
    function friendlyAuthError(error) {
      const messages = {
        "auth/email-already-in-use": "Ese correo ya tiene una cuenta.",
        "auth/invalid-email": "El correo electrónico no es válido.",
        "auth/invalid-credential": "Correo o contraseña incorrectos.",
        "auth/user-not-found": "No existe una cuenta con ese correo.",
        "auth/wrong-password": "Correo o contraseña incorrectos.",
        "auth/weak-password": "La clave debe tener al menos 8 caracteres.",
        "auth/operation-not-allowed": "Activa el proveedor Correo/contraseña en Firebase Authentication.",
        "auth/network-request-failed": "No se pudo conectar. Verifica tu conexión e inténtalo de nuevo."
      };
      return messages[error.code] || error.message || "Ocurrió un error de autenticación.";
    }
    function stopFirebaseListeners() {
      if (profileListener) profileListener.ref.off("value", profileListener.callback);
      if (sharedDataListener) sharedDataListener.ref.off("value", sharedDataListener.callback);
      if (profilesListener) profilesListener.ref.off("value", profilesListener.callback);
      if (invitationsListener) invitationsListener.ref.off("value", invitationsListener.callback);
      profileListener = null;
      sharedDataListener = null;
      profilesListener = null;
      invitationsListener = null;
    }
    function handleAuthState(authUser) {
      if (authFlowPending) return;
      stopFirebaseListeners();
      activeAuthUid = authUser ? authUser.uid : null;
      currentUser = null;
      if (!authUser) {
        pendingProfileDraft = null;
        showAuth();
        return;
      }
      const profileRef = firebaseDatabase.ref(`territorioSeguro/profiles/${authUser.uid}`);
      const callback = snapshot => {
        const profile = snapshot.val();
        if (profile) {
          profileRef.off("value", callback);
          profileListener = null;
          if (profile.status !== "approved") {
            firebaseAuth.signOut().then(() => renderLogin("Tu solicitud aún está pendiente de aprobación por el administrador.")).catch(error => console.error("No se pudo cerrar la sesión pendiente.", error));
            return;
          }
          activateFirebaseUser(authUser, profile);
          return;
        }
        let savedDraft = pendingProfileDraft;
        if (!savedDraft) {
          try { savedDraft = JSON.parse(localStorage.getItem("territorioSeguro.adminDraft") || "null"); } catch (error) { console.error("No se pudo leer la configuración inicial guardada.", error); }
        }
        if (authUser.uid !== INITIAL_ADMIN_UID || !savedDraft || savedDraft.uid !== authUser.uid) {
          firebaseAuth.signOut().then(() => renderLogin("Esta cuenta aún no tiene un perfil autorizado.")).catch(error => console.error("No se pudo cerrar la sesión sin perfil.", error));
          return;
        }
        profileRef.set({
          name: savedDraft.name,
          email: savedDraft.email,
          role: "admin",
          status: "approved",
          createdAt: new Date().toISOString()
        }).then(() => {
          localStorage.removeItem("territorioSeguro.adminDraft");
          pendingProfileDraft = null;
        }).catch(error => {
          console.error("No se pudo crear el perfil administrador en Firebase.", error);
          renderLogin("No se pudo autorizar el perfil. Verifica el UID y las reglas desplegadas.");
        });
      };
      profileListener = { ref: profileRef, callback };
      profileRef.on("value", callback, error => {
        console.error("No se pudo leer el perfil de Firebase.", error);
        renderLogin("No se pudieron validar los permisos. Revisa las reglas de Realtime Database.");
      });
    }
    function activateFirebaseUser(authUser, profile) {
      currentUser = { ...profile, id: authUser.uid, username: profile.email };
      state.users = [];
      state.invitations = [];
      sharedDataReady = false;
      sharedDataLoadError = "";
      sharedDataDiagnostic = "";
      loginAs(currentUser);
      const sharedRef = firebaseDatabase.ref("territorioSeguro/shared");
      const sharedCallback = snapshot => {
        const shared = snapshot.val() || {};
        const inspections = shared.inspections || {};
        const referencePlaces = shared.referencePlaces || {};
        const migrationDone = localStorage.getItem(MIGRATION_KEY) === "true";
        const legacyState = !migrationAttempted && !migrationDone ? loadState() : null;
        const shouldMigrate = currentUser.role === "admin" && !migrationDone && legacyState !== null;
        cloudCollectionKeys.inspections = Object.keys(inspections);
        cloudCollectionKeys.referencePlaces = Object.keys(referencePlaces);
        cloudCollectionData.inspections = inspections;
        cloudCollectionData.referencePlaces = referencePlaces;
        sharedDataReady = true;
        sharedDataLoadError = "";
        state.inspections = shouldMigrate ? mergeCloudRecords(legacyState.inspections, Object.values(inspections)) : Object.values(inspections);
        state.referencePlaces = shouldMigrate ? mergeCloudRecords(legacyState.referencePlaces, Object.values(referencePlaces)) : Object.values(referencePlaces);
        state.invitations = [];
        migrationAttempted = true;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderRecords();
        if (map) renderMarkers();
        if (currentUser.role === "admin") {
          renderAdmin();
          if (shouldMigrate) {
            const hasLegacyData = legacyState.inspections.length > 0 || legacyState.referencePlaces.length > 0;
            if (!hasLegacyData) localStorage.setItem(MIGRATION_KEY, "true");
            else saveState().then(synced => {
              if (synced) {
                localStorage.setItem(MIGRATION_KEY, "true");
                showToast("Datos locales migrados a Firebase.");
              }
            });
          }
        }
      };
      sharedDataListener = { ref: sharedRef, callback: sharedCallback };
      sharedRef.on("value", sharedCallback, error => {
        sharedDataReady = false;
        sharedDataLoadError = error.code || error.message || "error desconocido";
        console.error("No se pudieron leer los datos compartidos de Firebase.", error);
        const uid = firebaseAuth.currentUser?.uid;
        if (!uid) {
          sharedDataDiagnostic = `Firebase rechazó la lectura (${sharedDataLoadError}) y no hay una sesión activa.`;
          showSharedDataError(sharedDataDiagnostic);
          return;
        }
        firebaseDatabase.ref(`territorioSeguro/profiles/${uid}`).once("value").then(profileSnapshot => {
          const profile = profileSnapshot.val();
          const role = profile?.role || "sin perfil";
          const status = profile?.status || "sin estado";
          const guidance = role === "admin" && status === "approved"
            ? "El perfil está aprobado; comprueba que publicaste las reglas actualizadas en la misma Realtime Database configurada en la app."
            : "El perfil debe tener role=admin y status=approved para acceder. Cierra sesión y vuelve a entrar después de aprobarlo.";
          sharedDataDiagnostic = `Firebase denegó la lectura (${sharedDataLoadError}). UID: ${uid}; perfil: ${role}/${status}. ${guidance}`;
          showSharedDataError(sharedDataDiagnostic);
        }).catch(profileError => {
          console.error("No se pudo consultar el perfil para diagnosticar permisos.", profileError);
          sharedDataDiagnostic = `Firebase denegó la lectura (${sharedDataLoadError}) y tampoco permitió consultar el perfil (${profileError.code || profileError.message}).`;
          showSharedDataError(sharedDataDiagnostic);
        });
      });
      if (currentUser.role === "admin") {
        const profilesRef = firebaseDatabase.ref("territorioSeguro/profiles");
        const profilesCallback = snapshot => {
          state.users = Object.entries(snapshot.val() || {}).map(([id, user]) => ({ ...user, id, username: user.email }));
          renderAdmin();
          renderRecords();
        };
        profilesListener = { ref: profilesRef, callback: profilesCallback };
        profilesRef.on("value", profilesCallback, error => {
          console.error("No se pudieron leer las cuentas de Firebase.", error);
          showToast("No se pudieron cargar las cuentas para administrar.");
        });
        const invitationsRef = firebaseDatabase.ref("territorioSeguro/invitations");
        const invitationsCallback = snapshot => {
          state.invitations = Object.entries(snapshot.val() || {}).map(([code, invite]) => ({ code, ...invite }));
          renderAdmin();
        };
        invitationsListener = { ref: invitationsRef, callback: invitationsCallback };
        invitationsRef.on("value", invitationsCallback, error => {
          console.error("No se pudieron leer las invitaciones de Firebase.", error);
          showToast("No se pudieron cargar las invitaciones.");
        });
      }
    }
    function mergeCloudRecords(localRecords, cloudRecords) {
      const records = new Map(localRecords.map(record => [String(record.id), record]));
      cloudRecords.forEach(record => records.set(String(record.id), record));
      return Array.from(records.values());
    }
    function showSharedDataError(message) {
      document.getElementById("mapStatus").textContent = message;
      showToast(message);
    }
    function loginAs(user) {
      currentUser = user;
      document.getElementById("authScreen").classList.add("hidden");
      document.getElementById("app").classList.remove("hidden");
      if (!mapToolsManuallyToggled) setMapToolsExpanded(!window.matchMedia("(max-width: 760px)").matches);
      document.getElementById("currentUserName").textContent = user.name;
      document.getElementById("currentRole").textContent = user.role === "admin" ? "Administrador" : "Usuario aprobado";
      document.getElementById("adminNav").classList.toggle("hidden", user.role !== "admin");
      document.getElementById("openPlace").classList.toggle("hidden", user.role !== "admin");
      if (user.role === "admin") renderAdmin();
      renderRecords();
      showView("mapView");
      initializeMap();
    }
    function showView(viewId) {
      document.querySelectorAll(".view").forEach(view => view.classList.toggle("hidden", view.id !== viewId));
      document.querySelectorAll(".nav-button").forEach(button => button.classList.toggle("active", button.dataset.view === viewId));
      document.querySelector(".topbar .map-search").classList.toggle("hidden", viewId !== "mapView");
      document.getElementById("searchResults").classList.add("hidden");
      if (viewId === "mapView" && map) setTimeout(() => map.invalidateSize(), 80);
      if (viewId === "recordsView") renderRecords();
      if (viewId === "adminView" && currentUser?.role === "admin") renderAdmin();
    }
    function initializeMap() {
      if (!window.L) { document.getElementById("mapStatus").textContent = "No se pudo cargar el mapa. Verifica tu conexión a internet."; return; }
      if (!map) {
        map = L.map("map", { zoomControl: false, minZoom: 5, maxZoom: MAP_MAX_ZOOM, maxBoundsViscosity: 1, zoomAnimation: false }).setView([7.5, -67.5], 7);
        map.createPane("clickLocationPane");
        map.getPane("clickLocationPane").style.zIndex = "710";
        map.getPane("clickLocationPane").style.pointerEvents = "none";
        setBaseLayer(currentMapLayer);
        const zoomControl = L.control.zoom({ position: "bottomright" }).addTo(map);
        zoomControl.getContainer().querySelectorAll(".leaflet-control-zoom-in, .leaflet-control-zoom-out").forEach(button => {
          const zoomChange = button.classList.contains("leaflet-control-zoom-in") ? 1 : -1;
          button.addEventListener("click", event => {
            event.preventDefault();
            event.stopImmediatePropagation();
            if (button.getAttribute("aria-disabled") === "true") return;
            map.setZoomAround(mapZoomAnchor || map.getCenter(), map.getZoom() + zoomChange);
          }, true);
        });
        map.on("mousemove", event => {
          if (!event.originalEvent.target.closest(".leaflet-control")) mapZoomAnchor = event.latlng;
        });
        map.on("click", event => {
          mapZoomAnchor = event.latlng;
          handleMapLocationClick(event.latlng);
        });
      }
      loadApureMunicipalities().catch(error => {
        console.error("No se pudieron cargar los límites municipales de Apure.", error);
        document.getElementById("mapStatus").textContent = "No se pudieron cargar los límites municipales de Apure.";
        showToast("No se pudieron cargar los municipios de Apure. Comprueba que el archivo de límites esté disponible.");
      });
      renderMarkers();
    }
    function loadApureMunicipalities() {
      if (apureMunicipalityLoadPromise) return apureMunicipalityLoadPromise;
      apureMunicipalityLoadPromise = fetch(apureMunicipalitiesUrl).then(response => {
        if (!response.ok) throw new Error(`No se pudo leer el archivo de municipios (${response.status}).`);
        return response.json();
      }).then(collection => {
        if (!Array.isArray(collection.features) || collection.features.length !== 7 || collection.features.some(feature => !feature.properties?.municipality || !feature.geometry || !apureMunicipalityColors[feature.properties.municipality])) {
          throw new Error("El archivo de límites municipales no contiene los siete municipios esperados.");
        }
        apureMunicipalityFeatures = collection.features;
        const select = document.getElementById("inspectionMunicipality");
        select.innerHTML = `<option value="">Selecciona un municipio</option>` + apureMunicipalityFeatures
          .map(feature => `<option value="${escapeHtml(feature.properties.municipality)}">${escapeHtml(feature.properties.municipality)}</option>`)
          .join("");
        select.disabled = false;
        document.getElementById("municipalityLegend").innerHTML = `<strong>Municipios de Apure</strong>` + apureMunicipalityFeatures
          .map(feature => {
            const name = feature.properties.municipality;
            return `<button class="municipality-legend-row" type="button" data-municipality="${escapeHtml(name)}" aria-label="Acercar al municipio ${escapeHtml(name)}"><span class="municipality-swatch" style="--municipality-color: ${apureMunicipalityColors[name]}" aria-hidden="true"></span>${escapeHtml(name)}</button>`;
          })
          .join("");
        apureMunicipalityLabelLayer = L.layerGroup().addTo(map);
        apureMunicipalityLayer = L.geoJSON(collection, {
          style: feature => {
            const color = apureMunicipalityColors[feature.properties.municipality];
            return { color, weight: 2, opacity: 0.95, fillColor: color, fillOpacity: 0.34, bubblingMouseEvents: false };
          },
          onEachFeature: (feature, layer) => {
            const municipality = feature.properties.municipality;
            const color = apureMunicipalityColors[municipality];
            layer.on("click", event => {
              L.DomEvent.stopPropagation(event);
              handleMapLocationClick(event.latlng);
            });
            const labelIcon = L.divIcon({
              className: "municipality-label-marker",
              html: `<span class="municipality-label" style="--municipality-color: ${color}">${escapeHtml(municipality)}</span>`,
              iconSize: [160, 28],
              iconAnchor: [80, 14]
            });
            const municipalityLabel = L.marker(layer.getBounds().getCenter(), {
              icon: labelIcon,
              pane: "tooltipPane",
              keyboard: true,
              interactive: true,
              bubblingMouseEvents: false,
              zIndexOffset: 1000
            }).addTo(apureMunicipalityLabelLayer);
            municipalityLabel.on("click", event => {
              L.DomEvent.stopPropagation(event);
              handleMapLocationClick(event.latlng);
            });
          }
        }).addTo(map);
        map.attributionControl.addAttribution('Límites municipales &copy; <a href="https://www.geoboundaries.org/">geoBoundaries</a> (ODbL 1.0; fuente: Porto Tapiquen, 2015)');
        const apureBounds = apureMunicipalityLayer.getBounds();
        map.setMaxBounds(apureBounds.pad(0.06));
        map.setMinZoom(map.getBoundsZoom(apureBounds.pad(0.06)));
        map.fitBounds(apureBounds, { padding: [30, 30] });
      });
      return apureMunicipalityLoadPromise;
    }
    function zoomToMunicipality(name) {
      const layer = apureMunicipalityLayer?.getLayers().find(item => item.feature?.properties?.municipality === name);
      if (!layer) {
        showToast(`No se encontraron los límites del municipio ${name}.`);
        return;
      }
      map.fitBounds(layer.getBounds(), { padding: [36, 36], maxZoom: 12 });
      document.getElementById("mapStatus").textContent = `${name} · Apure`;
    }
    function focusMapLocationForActions(location) {
      pendingMapLocation = { latitude: location.lat, longitude: location.lng };
      mapZoomAnchor = L.latLng(location.lat, location.lng);
      map?.setView(location, MAP_MAX_ZOOM, { animate: false });
      document.getElementById("mapStatus").textContent = `${location.lat.toFixed(4)}° · ${location.lng.toFixed(4)}°`;
      openPointChoice(location);
    }
    function handleMapLocationClick(location) {
      if (pickLocationMode && mapPickTarget) {
        if (mapPickTarget.latitudeId === "latitude" && !getApureMunicipality(location.lat, location.lng)) {
          showToast("Marca la ubicación dentro de uno de los municipios de Apure.");
          return;
        }
        setCoordinates(location.lat, location.lng, mapPickTarget);
        const modalId = mapPickTarget.modalId;
        pickLocationMode = false;
        mapPickTarget = null;
        document.getElementById(modalId).classList.remove("hidden");
        showToast("Ubicación marcada en el mapa.");
        return;
      }
      focusMapLocationForActions(location);
    }
    function pointInRing(latitude, longitude, ring) {
      let inside = false;
      for (let index = 0, previous = ring.length - 1; index < ring.length; previous = index, index++) {
        const [x1, y1] = ring[previous];
        const [x2, y2] = ring[index];
        const crossProduct = (longitude - x1) * (y2 - y1) - (latitude - y1) * (x2 - x1);
        if (Math.abs(crossProduct) < 1e-10 &&
          longitude >= Math.min(x1, x2) && longitude <= Math.max(x1, x2) &&
          latitude >= Math.min(y1, y2) && latitude <= Math.max(y1, y2)) return true;
        if ((y1 > latitude) !== (y2 > latitude) &&
          longitude < (x2 - x1) * (latitude - y1) / (y2 - y1) + x1) inside = !inside;
      }
      return inside;
    }
    function pointInPolygon(latitude, longitude, polygon) {
      return pointInRing(latitude, longitude, polygon[0]) &&
        !polygon.slice(1).some(hole => pointInRing(latitude, longitude, hole));
    }
    function getApureMunicipality(latitude, longitude) {
      return apureMunicipalityFeatures.find(feature => {
        const { type, coordinates } = feature.geometry;
        if (type === "Polygon") return pointInPolygon(latitude, longitude, coordinates);
        if (type === "MultiPolygon") return coordinates.some(polygon => pointInPolygon(latitude, longitude, polygon));
        return false;
      })?.properties.municipality || "";
    }
    function getInspectionMunicipality(item) {
      return item.municipality || getApureMunicipality(Number(item.latitude), Number(item.longitude));
    }
    function setBaseLayer(layerName) {
      if (!map) return;
      if (baseLayer) map.removeLayer(baseLayer);
      referenceLayers.forEach(layer => map.removeLayer(layer));
      referenceLayers = [];
      currentMapLayer = layerName;
      if (layerName === "satellite") {
        baseLayer = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community" });
        referenceLayers = [
          L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Place labels &copy; Esri and contributors" }),
          L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}", { maxZoom: 19, attribution: "Roads and transport labels &copy; Esri and contributors" })
        ];
      } else {
        baseLayer = L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", { maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>' });
      }
      baseLayer.addTo(map);
      referenceLayers.forEach(layer => layer.addTo(map));
    }
    async function searchMapPlaces(query) {
      const resultsBox = document.getElementById("searchResults");
      const searchButton = document.querySelector("#mapSearchForm button");
      resultsBox.classList.add("hidden");
      if (!query.trim()) { showToast("Escribe el nombre de una zona para buscarla."); return; }
      if (!apureMunicipalityLayer) { showToast("Los límites municipales de Apure todavía se están cargando."); return; }
      searchButton.disabled = true;
      searchButton.textContent = "Buscando…";
      const localPlaces = [
        ...apureReferencePlaces.map(place => ({ ...place, kind: "place" })),
        ...state.referencePlaces.map(place => ({ ...place, kind: "place" })),
        ...state.inspections.map(item => ({ ...item, name: item.title, category: `Inspección · ${riskNames[item.risk]}`, kind: "inspection" }))
      ].filter(place => getApureMunicipality(Number(place.latitude), Number(place.longitude)));
      const normalizedQuery = query.trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      const localMatches = localPlaces.filter(place => [place.name, place.category, place.address, place.description].filter(Boolean).join(" ").toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").includes(normalizedQuery));
      let remotePlaces = [];
      try {
        const bounds = apureMunicipalityLayer.getBounds();
        const params = new URLSearchParams({
          q: query.trim(),
          countrycodes: "ve",
          format: "jsonv2",
          limit: "10",
          addressdetails: "1",
          bounded: "1",
          viewbox: `${bounds.getWest()},${bounds.getNorth()},${bounds.getEast()},${bounds.getSouth()}`
        });
        const response = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { "Accept-Language": "es" } });
        if (!response.ok) throw new Error("No se pudo consultar el buscador.");
        remotePlaces = (await response.json()).filter(place => getApureMunicipality(Number(place.lat), Number(place.lon)));
      } catch (error) {
        if (!localMatches.length) showToast("No se pudo buscar. Revisa la conexión a internet e inténtalo de nuevo.");
      } finally {
        searchButton.disabled = false;
        searchButton.textContent = "Buscar";
      }
      if (!localMatches.length && !remotePlaces.length) { showToast("No encontramos puntos que coincidan con la búsqueda."); return; }
      const localOptions = localMatches.map((place, index) => `<button class="search-result" type="button" role="option" data-result-source="local" data-result-index="${index}"><span>${escapeHtml(place.name)}</span><small class="search-result-type">${escapeHtml(place.category || "Punto guardado")}${place.address ? ` · ${escapeHtml(place.address)}` : ""}</small></button>`).join("");
      const remoteOptions = remotePlaces.map((place, index) => `<button class="search-result" type="button" role="option" data-result-source="remote" data-result-index="${index}"><span>${escapeHtml(place.display_name)}</span><small class="search-result-type">Resultado geográfico</small></button>`).join("");
      resultsBox.innerHTML = localOptions + remoteOptions;
      resultsBox.classList.remove("hidden");
      resultsBox.querySelectorAll("[data-result-index]").forEach(button => button.addEventListener("click", () => {
        if (button.dataset.resultSource === "local") {
          const place = localMatches[Number(button.dataset.resultIndex)];
          if (place.kind === "inspection") {
            const riskFilter = document.querySelector(`[data-filter="${place.risk}"]`);
            if (riskFilter) riskFilter.checked = true;
            renderMarkers();
          }
          focusMapPoint(place.latitude, place.longitude);
          const marker = markers.find(item => { const point = item.getLatLng?.(); return point && Math.abs(point.lat - place.latitude) < 0.000001 && Math.abs(point.lng - place.longitude) < 0.000001; });
          marker?.openPopup();
        } else {
          const place = remotePlaces[Number(button.dataset.resultIndex)];
          focusMapPoint(Number(place.lat), Number(place.lon));
        }
        resultsBox.classList.add("hidden");
      }));
    }
    function focusMapPoint(latitude, longitude) {
      mapZoomAnchor = L.latLng(latitude, longitude);
      map?.setView([latitude, longitude], Math.max(map.getZoom(), 14));
      document.getElementById("mapStatus").textContent = `${latitude.toFixed(4)}° · ${longitude.toFixed(4)}°`;
    }
    function updateReferenceMarkerVisibility() {
      if (!map) return;
      referenceMarkers.forEach(marker => {
        if (!map.hasLayer(marker)) marker.addTo(map);
      });
    }
    function renderMapDatePicker() {
      const today = new Date();
      const center = selectedMapDate
        ? new Date(`${selectedMapDate}T12:00:00`)
        : new Date(today.getFullYear(), today.getMonth(), today.getDate() + mapDateWindowOffset);
      const days = [];
      for (let offset = -2; offset <= 2; offset++) {
        const date = new Date(center.getFullYear(), center.getMonth(), center.getDate() + offset);
        const key = localDateKey(date);
        const count = state.inspections.filter(item => Number.isFinite(new Date(item.date).getTime()) && localDateKey(new Date(item.date)) === key).length;
        const weekday = new Intl.DateTimeFormat("es-VE", { weekday: "short" }).format(date).replace(".", "");
        const month = new Intl.DateTimeFormat("es-VE", { month: "short" }).format(date).replace(".", "");
        const label = new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(date);
        days.push(`<button class="map-date-day${selectedMapDate === key ? " active" : ""}${key === localDateKey(today) ? " today" : ""}" type="button" data-map-date="${key}" aria-pressed="${selectedMapDate === key}" aria-label="${escapeHtml(label)}: ${count} ${count === 1 ? "inspección" : "inspecciones"}"><strong>${date.getDate()}</strong><span>${escapeHtml(weekday)}</span><small>${escapeHtml(month)}${count ? ` · ${count}` : ""}</small></button>`);
      }
      document.getElementById("mapDateDays").innerHTML = days.join("");
      document.getElementById("mapDateInput").value = selectedMapDate;
      document.getElementById("mapDateAll").setAttribute("aria-pressed", String(!selectedMapDate));
      const dateSummary = document.getElementById("mapDateSummary");
      if (!selectedMapDate) {
        dateSummary.textContent = `${state.inspections.length} ${state.inspections.length === 1 ? "inspección en todas las fechas" : "inspecciones en todas las fechas"}`;
      } else {
        const count = state.inspections.filter(item => Number.isFinite(new Date(item.date).getTime()) && localDateKey(new Date(item.date)) === selectedMapDate).length;
        dateSummary.textContent = `${count} ${count === 1 ? "inspección" : "inspecciones"} · ${new Intl.DateTimeFormat("es-VE", { day: "numeric", month: "long", year: "numeric" }).format(new Date(`${selectedMapDate}T12:00:00`))}`;
      }
    }
    function shiftMapDateWindow(direction) {
      if (selectedMapDate) {
        const current = new Date(`${selectedMapDate}T12:00:00`);
        current.setDate(current.getDate() + direction);
        selectedMapDate = localDateKey(current);
      } else {
        mapDateWindowOffset += direction * 5;
      }
      renderMarkers();
    }
    function selectMapDate(dateKey) {
      selectedMapDate = dateKey;
      mapDateWindowOffset = 0;
      renderMarkers();
    }
    function canEditInspection(item) {
      return currentUser?.role === "admin" ||
        (item.createdBy === currentUser?.id && Number.isFinite(Number(item.ownerEditUntil)) && Date.now() < Number(item.ownerEditUntil));
    }
    function bindEditableMarker(marker, item, type) {
      const canEdit = type === "inspection" ? canEditInspection(item) : currentUser?.role === "admin";
      if (!canEdit) return;
      marker.on("dragend", event => {
        if (!sharedDataReady) { renderMarkers(); showToast("Espera a que terminen de cargar los datos."); return; }
        if (type === "inspection" && !canEditInspection(item)) {
          renderMarkers();
          showToast("Solo el administrador puede modificar inspecciones después de su fecha límite.");
          return;
        }
        const location = event.target.getLatLng();
        const municipality = getApureMunicipality(location.lat, location.lng);
        if (type === "inspection" && !municipality) {
          renderMarkers();
          showToast("Las inspecciones deben permanecer dentro de un municipio de Apure.");
          return;
        }
        item.latitude = location.lat;
        item.longitude = location.lng;
        if (type === "inspection") item.municipality = municipality;
        saveState();
        renderMarkers();
        showToast("Ubicación actualizada.");
      });
    }
    function renderMarkers() {
      if (!map) return;
      renderMapDatePicker();
      markers.forEach(marker => marker.remove());
      markers = [];
      referenceMarkers = [];
      const visibleRisks = new Set(Array.from(document.querySelectorAll("[data-filter]:checked"), input => input.dataset.filter));
      state.inspections.forEach(item => {
        if (!visibleRisks.has(item.risk) || !Number.isFinite(item.latitude) || !Number.isFinite(item.longitude)) return;
        if (selectedMapDate && localDateKey(new Date(item.date)) !== selectedMapDate) return;
        const normalizedType = String(item.type || "").trim().toLocaleLowerCase("es");
        const typeIcon = inspectionTypeIcons[normalizedType] || inspectionTypeIcons.otro;
        const iconLabel = `${item.type || "Inspección"} · ${riskNames[item.risk] || "Riesgo no clasificado"}`;
        const icon = L.divIcon({
          className: "inspection-map-icon",
          html: `<span class="inspection-pin ${escapeHtml(item.risk)}" role="img" aria-label="${escapeHtml(iconLabel)}"><span>${typeIcon}</span></span>`,
          iconSize: [38, 46],
          iconAnchor: [19, 43],
          popupAnchor: [0, -40]
        });
        const canEdit = canEditInspection(item);
        const marker = L.marker([item.latitude, item.longitude], { icon, draggable: false, inspectionId: item.id }).addTo(map);
        const municipality = getInspectionMunicipality(item);
        const submitter = getInspectionSubmitter(item);
        const whatsappUrl = getWhatsAppUrl(submitter.phone);
        const directionsUrl = getDirectionsUrl(item.latitude, item.longitude);
        marker.bindPopup(`<div class="popup-title">${escapeHtml(item.title)}</div><div class="popup-detail"><b>${escapeHtml(riskNames[item.risk] || "Riesgo no clasificado")}</b><br>${escapeHtml(municipality ? `${municipality} · Apure` : "Municipio no registrado")}<br>${escapeHtml(item.type)} · ${new Date(item.date).toLocaleString("es-VE")}<br>${escapeHtml(item.address || "Sin referencia de dirección")}<br>Inspector: ${escapeHtml(item.inspectorName || "No especificado")}<br>Registró: ${escapeHtml(submitter.name)}<br>${escapeHtml([submitter.cedula, submitter.hierarchy, submitter.organization].filter(Boolean).join(" · ") || "Sin datos del perfil")}<br>${whatsappUrl ? `<a href="${escapeHtml(whatsappUrl)}" target="_blank" rel="noopener noreferrer">WhatsApp ${escapeHtml(submitter.phone)}</a>` : `Teléfono: ${escapeHtml(submitter.phone || "No registrado")}`}${submitter.email ? `<br><a href="mailto:${escapeHtml(submitter.email)}">${escapeHtml(submitter.email)}</a>` : ""}</div><a class="button secondary small inspection-directions" href="${escapeHtml(directionsUrl)}" target="_blank" rel="noopener noreferrer">↗ Cómo llegar desde mi ubicación</a><div class="popup-actions"><button class="button secondary small point-profile" type="button">Ver perfil</button>${canEdit ? `<button class="button secondary small point-edit" type="button">Editar</button><button class="button danger small point-delete" type="button">Eliminar</button>` : ""}</div>`);
        marker.on("click", () => focusMapPoint(item.latitude, item.longitude));
        marker.on("popupopen", event => {
          const popup = event.popup.getElement();
          popup.querySelector(".point-profile").addEventListener("click", () => openUserProfile(item.createdBy, item.submittedByProfile));
          if (canEdit) {
            popup.querySelector(".point-edit").addEventListener("click", () => openReport(item));
            popup.querySelector(".point-delete").addEventListener("click", () => deleteInspection(item.id));
          }
        });
        markers.push(marker);
      });
      apureReferencePlaces.forEach(place => {
        const marker = L.circleMarker([place.latitude, place.longitude], { radius: 7, color: "#fff", weight: 2, fillColor: "#176b52", fillOpacity: 1 });
        marker.bindTooltip(escapeHtml(place.name), { permanent: true, direction: "right", className: "place-label", offset: [8, 0] });
        marker.bindPopup(`<div class="popup-title">${escapeHtml(place.name)}</div><div class="popup-detail">${escapeHtml(place.category)}<br>${escapeHtml(place.address)}<br>Coordenadas: ${place.latitude}, ${place.longitude}</div>`);
        marker.on("click", () => focusMapPoint(place.latitude, place.longitude));
        markers.push(marker);
        referenceMarkers.push(marker);
      });
      state.referencePlaces.forEach(place => {
        const canEdit = currentUser?.role === "admin";
        const marker = L.marker([place.latitude, place.longitude], { icon: L.divIcon({ className: "place-marker-icon", html: '<span class="place-marker"></span>', iconSize: [20, 20], iconAnchor: [10, 10] }), draggable: canEdit });
        marker.bindTooltip(escapeHtml(place.name), { permanent: true, direction: "right", className: "place-label", offset: [8, 0] });
        marker.bindPopup(`<div class="popup-title">${escapeHtml(place.name)}</div><div class="popup-detail">${escapeHtml(place.category)}${place.address ? `<br>${escapeHtml(place.address)}` : ""}${place.description ? `<br>${escapeHtml(place.description)}` : ""}<br>Coordenadas: ${place.latitude}, ${place.longitude}</div>${canEdit ? `<div class="popup-actions"><button class="button secondary small place-edit" type="button">Editar</button><button class="button danger small place-delete" type="button">Eliminar</button></div>` : ""}`);
        marker.on("click", () => focusMapPoint(place.latitude, place.longitude));
        bindEditableMarker(marker, place, "place");
        if (canEdit) marker.on("popupopen", event => {
          const popup = event.popup.getElement();
          popup.querySelector(".place-edit").addEventListener("click", () => openPlaceForm(place));
          popup.querySelector(".place-delete").addEventListener("click", () => deleteReferencePlace(place.id));
        });
        markers.push(marker);
        referenceMarkers.push(marker);
      });
      updateReferenceMarkerVisibility();
    }
    function setCoordinates(latitude, longitude, target = {}) {
      document.getElementById(target.latitudeId || "latitude").value = latitude;
      document.getElementById(target.longitudeId || "longitude").value = longitude;
      document.getElementById(target.coordsLabelId || "coordsLabel").textContent = `${latitude.toFixed(6)}, ${longitude.toFixed(6)}`;
      document.getElementById("mapStatus").textContent = `${latitude.toFixed(4)}° · ${longitude.toFixed(4)}°`;
      if (!target.latitudeId || target.municipalityId) {
        const municipality = getApureMunicipality(latitude, longitude);
        document.getElementById(target.municipalityId || "inspectionMunicipality").value = municipality;
        document.getElementById(target.messageId || "reportMessage").textContent = municipality
          ? `Municipio detectado: ${municipality}, Apure.`
          : "La ubicación debe estar dentro de uno de los municipios de Apure.";
        if (!target.latitudeId && !editingInspectionId && municipality) fillInspectionPlace(latitude, longitude, municipality);
      }
    }
    async function fillInspectionPlace(latitude, longitude, municipality) {
      const lookupId = ++inspectionPlaceLookupId;
      const titleInput = document.getElementById("inspectionTitle");
      const addressInput = document.getElementById("inspectionAddress");
      const titleWasEdited = inspectionTitleEdited;
      const addressWasEdited = inspectionAddressEdited;
      const fallbackAddress = `${municipality}, Apure`;
      let placeName = municipality;
      let addressText = fallbackAddress;
      try {
        const params = new URLSearchParams({
          lat: String(latitude),
          lon: String(longitude),
          format: "jsonv2",
          addressdetails: "1",
          zoom: "18"
        });
        const response = await fetch(`https://nominatim.openstreetmap.org/reverse?${params}`, {
          headers: { "Accept-Language": "es" }
        });
        if (!response.ok) throw new Error(`La consulta de lugar respondió ${response.status}.`);
        const result = await response.json();
        const address = result.address || {};
        const localName = address.neighbourhood || address.suburb || address.hamlet || address.village ||
          address.town || address.city || address.road || municipality;
        placeName = result.name || localName;
        const street = [address.road, address.house_number].filter(Boolean).join(" ");
        addressText = [street, address.neighbourhood || address.suburb || address.hamlet, address.village || address.town || address.city, municipality, "Apure"]
          .filter((part, index, parts) => part && parts.indexOf(part) === index)
          .join(", ")
          .slice(0, 180) || fallbackAddress;
      } catch (error) {
        console.warn("No se pudo identificar el lugar seleccionado; se usará el municipio.", error);
        if (lookupId !== inspectionPlaceLookupId) return;
        if (!titleWasEdited && !titleInput.value.trim()) titleInput.value = municipality;
        if (!addressWasEdited && !addressInput.value.trim()) addressInput.value = fallbackAddress;
        document.getElementById("reportMessage").textContent = `No se pudo consultar el nombre exacto del lugar. Se completó el municipio ${municipality}, Apure.`;
        return;
      }
      if (lookupId !== inspectionPlaceLookupId) return;
      if (!titleWasEdited && !titleInput.value.trim()) titleInput.value = placeName.slice(0, 120);
      if (!addressWasEdited && !addressInput.value.trim()) addressInput.value = addressText;
      document.getElementById("reportMessage").textContent = `Lugar detectado: ${placeName}, ${municipality}, Apure.`;
    }
    function openPlaceForm(place = null) {
      if (currentUser?.role !== "admin") return;
      editingPlaceId = place?.id || null;
      const form = document.getElementById("placeForm");
      form.reset();
      const inspectionLink = document.getElementById("placeInspectionLink");
      inspectionLink.innerHTML = `<option value="">Sin vincular</option>` + state.inspections
        .map(inspection => `<option value="${escapeHtml(inspection.id)}">${escapeHtml(inspection.title)} · ${new Date(inspection.date).toLocaleDateString("es-VE")}</option>`)
        .join("");
      document.getElementById("placeTitle").textContent = place ? "Editar punto de referencia" : "Agregar punto de referencia";
      form.querySelector('[type="submit"]').textContent = place ? "Guardar cambios" : "Guardar punto";
      if (place) {
        document.getElementById("placeName").value = place.name;
        document.getElementById("placeCategory").value = place.category;
        document.getElementById("placeAddress").value = place.address || "";
        document.getElementById("placeDescription").value = place.description || "";
        inspectionLink.value = place.inspectionId || "";
        setCoordinates(place.latitude, place.longitude, { latitudeId: "placeLatitude", longitudeId: "placeLongitude", coordsLabelId: "placeCoordsLabel" });
      } else {
        document.getElementById("placeCoordsLabel").textContent = "Ubicación pendiente";
      }
      document.getElementById("placeMessage").textContent = "";
      document.getElementById("placeModal").classList.remove("hidden");
    }
    function closePlaceForm() {
      document.getElementById("placeModal").classList.add("hidden");
      editingPlaceId = null;
      if (mapPickTarget?.modalId === "placeModal") { pickLocationMode = false; mapPickTarget = null; }
    }
    function openPointChoice(location) {
      closePointChoice();
      pendingMapLocation = { latitude: location.lat, longitude: location.lng };
      pendingLocationMarker = L.circleMarker(location, {
        radius: 5,
        color: "#fff",
        weight: 2,
        fillColor: "#f45113",
        fillOpacity: 1,
        pane: "clickLocationPane",
        className: "map-click-location-dot",
        interactive: false
      }).addTo(map);
      const placeButton = currentUser?.role === "admin"
        ? '<button class="button secondary" type="button" data-map-action="place">＋ Lugar de referencia</button>'
        : "";
      const popup = L.popup({ closeButton: true, autoPan: true, closeOnClick: false, offset: [0, 14], className: "map-add-actions-popup", maxWidth: 320 })
        .setLatLng(location)
        .setContent(`<div class="map-add-actions"><button class="button" type="button" data-map-action="inspection">＋ Agregar inspección</button>${placeButton}</div>`);
      pointChoicePopup = popup;
      popup.on("remove", () => {
        if (pointChoicePopup === popup) {
          if (pendingLocationMarker && map?.hasLayer(pendingLocationMarker)) map.removeLayer(pendingLocationMarker);
          pendingLocationMarker = null;
          pointChoicePopup = null;
          pendingMapLocation = null;
        }
      });
      popup.once("add", () => {
        const popupElement = popup.getElement();
        const buttons = popupElement?.querySelectorAll("[data-map-action]");
        if (!buttons) return;
        buttons.forEach(button => button.addEventListener("click", event => {
          event.preventDefault();
          event.stopPropagation();
          continueWithMapLocation(button.dataset.mapAction);
        }));
      });
      map.openPopup(popup);
    }
    function closePointChoice() {
      if (pointChoicePopup && map?.hasLayer(pointChoicePopup)) map.closePopup(pointChoicePopup);
      if (pendingLocationMarker && map?.hasLayer(pendingLocationMarker)) map.removeLayer(pendingLocationMarker);
      pointChoicePopup = null;
      pendingLocationMarker = null;
      pendingMapLocation = null;
    }
    function continueWithMapLocation(type) {
      if (!pendingMapLocation) return;
      const location = pendingMapLocation;
      closePointChoice();
      if (type === "inspection") {
        if (!getApureMunicipality(location.latitude, location.longitude)) {
          showToast("Solo se pueden registrar inspecciones dentro de los municipios de Apure.");
          return;
        }
        openReport();
        setCoordinates(location.latitude, location.longitude);
      } else if (type === "place" && currentUser?.role === "admin") {
        openPlaceForm();
        setCoordinates(location.latitude, location.longitude, { latitudeId: "placeLatitude", longitudeId: "placeLongitude", coordsLabelId: "placeCoordsLabel" });
      }
    }
    function startMapPick(target) {
      document.getElementById(target.modalId).classList.add("hidden");
      mapPickTarget = target;
      pickLocationMode = true;
      showView("mapView");
      document.getElementById("mapStatus").textContent = "Haz clic en el mapa para marcar la ubicación";
      showToast("Selecciona un punto en el mapa.");
    }
    async function saveReferencePlace(event) {
      event.preventDefault();
      if (!sharedDataReady) { document.getElementById("placeMessage").textContent = "Espera a que terminen de cargar los datos antes de guardar."; return; }
      const latitudeInput = document.getElementById("placeLatitude").value;
      const longitudeInput = document.getElementById("placeLongitude").value;
      if (!latitudeInput || !longitudeInput) { document.getElementById("placeMessage").textContent = "Obtén la ubicación por GPS o márcala en el mapa antes de guardar."; return; }
      const values = { name: document.getElementById("placeName").value.trim(), category: document.getElementById("placeCategory").value, address: document.getElementById("placeAddress").value.trim(), description: document.getElementById("placeDescription").value.trim(), latitude: Number(latitudeInput), longitude: Number(longitudeInput) };
      const linkedInspectionId = document.getElementById("placeInspectionLink").value;
      if (linkedInspectionId) values.inspectionId = linkedInspectionId;
      const wasEditing = Boolean(editingPlaceId);
      const previousPlaces = JSON.parse(JSON.stringify(state.referencePlaces));
      if (editingPlaceId) {
        const place = state.referencePlaces.find(item => item.id === editingPlaceId);
        if (!place) { document.getElementById("placeMessage").textContent = "No se encontró el punto que intentas editar."; return; }
        delete place.inspectionId;
        Object.assign(place, values);
      } else {
        state.referencePlaces.push({ id: crypto.randomUUID(), ...values, createdBy: currentUser.id, createdAt: new Date().toISOString() });
      }
      const saved = await saveState();
      if (!saved) {
        state.referencePlaces = previousPlaces;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderMarkers();
        document.getElementById("placeMessage").textContent = "No se pudo guardar el punto en Firebase. Revisa los permisos y vuelve a intentarlo.";
        return;
      }
      closePlaceForm();
      renderMarkers();
      showToast(wasEditing ? "Punto de referencia actualizado en Firebase." : "Punto de referencia guardado en Firebase.");
    }
    async function deleteInspection(id) {
      if (!sharedDataReady) { showToast("Espera a que terminen de cargar los datos."); return; }
      const inspection = state.inspections.find(item => item.id === id);
      if (!inspection) return;
      if (!canEditInspection(inspection)) {
        showToast("Solo el administrador puede modificar o eliminar inspecciones después de su fecha límite.");
        return;
      }
      const linkedPlaces = state.referencePlaces.filter(place => place.inspectionId === id);
      const placeNotice = linkedPlaces.length
        ? ` También se eliminarán ${linkedPlaces.length} punto(s) de referencia vinculado(s).`
        : "";
      if (!confirm(`¿Eliminar esta inspección?${placeNotice} Esta acción no se puede deshacer.`)) return;
      if (!canEditInspection(inspection)) {
        showToast("Solo el administrador puede modificar o eliminar inspecciones después de su fecha límite.");
        return;
      }
      const previousInspections = state.inspections;
      const previousPlaces = state.referencePlaces;
      state.inspections = state.inspections.filter(item => item.id !== id);
      state.referencePlaces = state.referencePlaces.filter(place => place.inspectionId !== id);
      const saved = await saveState({ referencePlacesFirst: linkedPlaces.length > 0 });
      if (!saved) {
        state.inspections = previousInspections;
        state.referencePlaces = previousPlaces;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        for (const place of linkedPlaces) {
          try {
            await firebaseDatabase.ref(`territorioSeguro/shared/referencePlaces/${place.id}`).set(place);
          } catch (error) {
            console.error("No se pudo restaurar un punto vinculado después de fallar la eliminación.", error);
          }
        }
        return;
      }
      renderMarkers();
      renderRecords();
      showToast(linkedPlaces.length
        ? `Inspección eliminada junto con ${linkedPlaces.length} punto(s) vinculado(s).`
        : "Inspección eliminada.");
    }
    function deleteReferencePlace(id) {
      if (!sharedDataReady) { showToast("Espera a que terminen de cargar los datos."); return; }
      if (!confirm("¿Eliminar este punto de referencia?")) return;
      state.referencePlaces = state.referencePlaces.filter(place => place.id !== id);
      saveState();
      renderMarkers();
      showToast("Punto de referencia eliminado.");
    }
    function localDateTimeValue(date) {
      const pad = value => String(value).padStart(2, "0");
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }
    function setInspectionDate(date) {
      document.getElementById("inspectionDate").value = localDateTimeValue(date);
      calendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      document.getElementById("inspectionTime").value = `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
      document.getElementById("inspectionDateLabel").textContent = new Intl.DateTimeFormat("es-VE", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date);
      document.getElementById("inspectionTimeLabel").textContent = document.getElementById("inspectionTime").value;
      document.querySelector(".date-trigger-icon").textContent = String(date.getDate()).padStart(2, "0");
      renderInspectionCalendar();
    }
    function renderInspectionCalendar() {
      const month = new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), 1);
      document.getElementById("calendarMonthLabel").textContent = new Intl.DateTimeFormat("es-VE", { month: "long", year: "numeric" }).format(month);
      const dateValue = document.getElementById("inspectionDate").value;
      const selectedDate = dateValue ? new Date(`${dateValue.slice(0, 10)}T00:00:00`) : null;
      const today = new Date();
      const firstWeekday = (month.getDay() + 6) % 7;
      const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
      const cells = [];
      for (let index = 0; index < cellCount; index++) {
        const day = index - firstWeekday + 1;
        if (day < 1 || day > daysInMonth) { cells.push('<span class="calendar-empty" aria-hidden="true"></span>'); continue; }
        const classes = ["calendar-day"];
        if (day === today.getDate() && month.getFullYear() === today.getFullYear() && month.getMonth() === today.getMonth()) classes.push("today");
        if (selectedDate && day === selectedDate.getDate() && month.getFullYear() === selectedDate.getFullYear() && month.getMonth() === selectedDate.getMonth()) classes.push("selected");
        cells.push(`<button type="button" class="${classes.join(" ")}" data-day="${day}" aria-label="${day} de ${month.toLocaleDateString("es-VE", { month: "long" })}">${day}</button>`);
      }
      document.getElementById("calendarDays").innerHTML = cells.join("");
    }
    function toggleDatePicker(forceOpen) {
      const picker = document.getElementById("datePicker");
      const shouldOpen = forceOpen ?? picker.classList.contains("hidden");
      picker.classList.toggle("hidden", !shouldOpen);
      document.getElementById("openDatePicker").setAttribute("aria-expanded", String(shouldOpen));
      if (shouldOpen) renderInspectionCalendar();
    }
    function openReport(inspection = null) {
      if (!currentUser || currentUser.role !== "admin" && currentUser.status !== "approved") return;
      if (inspection && !canEditInspection(inspection)) {
        showToast("Solo el administrador puede modificar inspecciones después de su fecha límite.");
        return;
      }
      if (apureMunicipalityFeatures.length !== 7) { showToast("Espera a que carguen los límites municipales de Apure antes de reportar."); return; }
      editingInspectionId = inspection?.id || null;
      const form = document.getElementById("reportForm");
      form.reset();
      inspectionPlaceLookupId++;
      inspectionTitleEdited = Boolean(inspection);
      inspectionAddressEdited = Boolean(inspection);
      document.getElementById("reportMessage").textContent = "";
      document.getElementById("coordsLabel").textContent = "Ubicación pendiente";
      document.getElementById("reportTitle").textContent = inspection ? "Editar inspección" : "Reportar inspección";
      form.querySelector('[type="submit"]').textContent = inspection ? "Guardar cambios" : "Guardar inspección";
      if (inspection) {
        document.getElementById("inspectorName").value = inspection.inspectorName;
        document.getElementById("inspectorCedula").value = inspection.inspectorCedula || "";
        document.getElementById("inspectorPhone").value = inspection.inspectorPhone;
        document.getElementById("inspectorHierarchy").value = inspection.inspectorHierarchy || "";
        document.getElementById("inspectorOrganization").value = inspection.organization || "";
        document.getElementById("inspectionTitle").value = inspection.title;
        document.getElementById("inspectionRisk").value = inspection.risk;
        document.getElementById("inspectionType").value = inspection.type;
        document.getElementById("inspectionDescription").value = inspection.description;
        document.getElementById("inspectionAffectedPeople").value = inspection.affectedPeople ?? "";
        document.getElementById("inspectionAffectedStructures").value = inspection.affectedStructures ?? "";
        document.getElementById("inspectionActions").value = inspection.actionsTaken || "";
        document.getElementById("inspectionSupport").value = inspection.supportRequired || "";
        document.getElementById("inspectionAddress").value = inspection.address || "";
        setCoordinates(inspection.latitude, inspection.longitude);
        setInspectionDate(new Date(inspection.date));
      } else {
        document.getElementById("inspectorName").value = currentUser.name;
        document.getElementById("inspectorCedula").value = currentUser.cedula || "";
        document.getElementById("inspectorPhone").value = currentUser.phone || "";
        document.getElementById("inspectorHierarchy").value = currentUser.hierarchy || "";
        document.getElementById("inspectorOrganization").value = currentUser.organization || "";
        setInspectionDate(new Date());
      }
      toggleDatePicker(false);
      document.getElementById("reportModal").classList.remove("hidden");
      form.scrollTop = 0;
      if (map) setTimeout(() => map.invalidateSize(), 100);
    }
    function closeReport() {
      document.getElementById("reportModal").classList.add("hidden");
      editingInspectionId = null;
      if (mapPickTarget?.modalId === "reportModal") { pickLocationMode = false; mapPickTarget = null; }
    }
    function useGPS(target = {}) {
      const message = document.getElementById(target.messageId || "reportMessage");
      if (!navigator.geolocation) { message.textContent = "Este navegador no permite geolocalización."; return; }
      message.textContent = "Solicitando permiso de ubicación…";
      navigator.geolocation.getCurrentPosition(position => {
        setCoordinates(position.coords.latitude, position.coords.longitude, target);
        message.textContent = `GPS obtenido (precisión aproximada: ${Math.round(position.coords.accuracy)} m).`;
      }, error => {
        const errors = { 1: "Permiso denegado. Habilita la ubicación en el navegador e inténtalo de nuevo.", 2: "No fue posible determinar la ubicación. Comprueba el GPS del dispositivo.", 3: "Se agotó el tiempo de espera del GPS." };
        message.textContent = errors[error.code] || "No se pudo obtener la ubicación.";
      }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 });
    }
    async function saveInspection(event) {
      event.preventDefault();
      if (!sharedDataReady) {
        const reason = sharedDataDiagnostic || (sharedDataLoadError
          ? `Firebase no permitió cargar los datos (${sharedDataLoadError}). Espera al diagnóstico de permisos antes de guardar.`
          : "La app todavía está esperando la respuesta de Realtime Database. Comprueba tu conexión y vuelve a intentarlo.");
        document.getElementById("reportMessage").textContent = reason;
        return;
      }
      const latitude = Number(document.getElementById("latitude").value);
      const longitude = Number(document.getElementById("longitude").value);
      if (!document.getElementById("latitude").value || !document.getElementById("longitude").value || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
        document.getElementById("reportMessage").textContent = "Obtén la ubicación por GPS o márcala en el mapa antes de guardar."; return;
      }
      if (apureMunicipalityFeatures.length !== 7) {
        document.getElementById("reportMessage").textContent = "No se pueden validar las coordenadas porque los límites municipales de Apure no están disponibles."; return;
      }
      const municipality = getApureMunicipality(latitude, longitude);
      const selectedMunicipality = document.getElementById("inspectionMunicipality").value;
      if (!municipality) {
        document.getElementById("reportMessage").textContent = "La ubicación debe estar dentro de uno de los municipios de Apure."; return;
      }
      if (selectedMunicipality !== municipality) {
        document.getElementById("reportMessage").textContent = `Las coordenadas corresponden al municipio ${municipality}. Marca una ubicación dentro del municipio seleccionado.`; return;
      }
      const inspectionDate = document.getElementById("inspectionDate").value;
      if (!inspectionDate) { document.getElementById("reportMessage").textContent = "Selecciona la fecha y hora de la inspección."; return; }
      const affectedPeople = document.getElementById("inspectionAffectedPeople").value;
      const affectedStructures = document.getElementById("inspectionAffectedStructures").value;
      const values = { title: document.getElementById("inspectionTitle").value.trim(), risk: document.getElementById("inspectionRisk").value, type: document.getElementById("inspectionType").value, date: new Date(inspectionDate).toISOString(), description: document.getElementById("inspectionDescription").value.trim(), affectedPeople: affectedPeople === "" ? null : Number(affectedPeople), affectedStructures: affectedStructures === "" ? null : Number(affectedStructures), actionsTaken: document.getElementById("inspectionActions").value.trim(), supportRequired: document.getElementById("inspectionSupport").value.trim(), address: document.getElementById("inspectionAddress").value.trim(), municipality, latitude, longitude, inspectorName: document.getElementById("inspectorName").value.trim(), inspectorCedula: document.getElementById("inspectorCedula").value.trim(), inspectorPhone: document.getElementById("inspectorPhone").value.trim(), inspectorHierarchy: document.getElementById("inspectorHierarchy").value.trim(), organization: document.getElementById("inspectorOrganization").value.trim() };
      const previousInspections = JSON.parse(JSON.stringify(state.inspections));
      if (editingInspectionId) {
        const inspection = state.inspections.find(item => item.id === editingInspectionId);
        if (!inspection) { document.getElementById("reportMessage").textContent = "No se encontró la inspección que intentas editar."; return; }
        if (!canEditInspection(inspection)) { document.getElementById("reportMessage").textContent = "Solo el administrador puede modificar inspecciones después de su fecha límite."; return; }
        Object.assign(inspection, values);
      } else {
        const submittedByProfile = {
          name: currentUser.name || "",
          cedula: currentUser.cedula || "",
          phone: currentUser.phone || "",
          organization: currentUser.organization || "",
          hierarchy: currentUser.hierarchy || "",
          email: currentUser.email || ""
        };
        const ownerEditDate = new Date(values.date);
        ownerEditDate.setHours(24, 0, 0, 0);
        state.inspections.push({ id: crypto.randomUUID(), ...values, createdBy: currentUser.id, submittedByName: currentUser.name, submittedByProfile, createdAt: new Date().toISOString(), ownerEditUntil: ownerEditDate.getTime() });
      }
      const wasEditing = Boolean(editingInspectionId);
      const synced = await saveState();
      if (!synced) {
        state.inspections = previousInspections;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        renderMarkers();
        renderRecords();
        document.getElementById("reportMessage").textContent = "La inspección no se guardó en Firebase. Comprueba tu conexión, tu sesión y las reglas de Realtime Database; revisa también el mensaje de error.";
        return;
      }
      closeReport();
      renderMarkers();
      renderRecords();
      showToast(wasEditing ? "Cambios guardados en Firebase." : "Inspección guardada en Firebase.");
    }
    function localDateKey(date) {
      return localDateTimeValue(date).slice(0, 10);
    }
    function renderRecordsCalendar() {
      const month = new Date(recordsCalendarMonth.getFullYear(), recordsCalendarMonth.getMonth(), 1);
      document.getElementById("recordsCalendarMonthLabel").textContent = new Intl.DateTimeFormat("es-VE", { month: "long", year: "numeric" }).format(month);
      const selected = document.getElementById("recordsDateFilter").value;
      const today = localDateKey(new Date());
      const firstWeekday = (month.getDay() + 6) % 7;
      const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
      const cellCount = Math.ceil((firstWeekday + daysInMonth) / 7) * 7;
      const cells = [];
      for (let index = 0; index < cellCount; index++) {
        const day = index - firstWeekday + 1;
        if (day < 1 || day > daysInMonth) { cells.push('<span class="calendar-empty" aria-hidden="true"></span>'); continue; }
        const dayKey = localDateKey(new Date(month.getFullYear(), month.getMonth(), day));
        const classes = ["calendar-day"];
        if (dayKey === today) classes.push("today");
        if (dayKey === selected) classes.push("selected");
        cells.push(`<button type="button" class="${classes.join(" ")}" data-record-day="${day}">${day}</button>`);
      }
      document.getElementById("recordsCalendarDays").innerHTML = cells.join("");
    }
    function setRecordsDate(date) {
      const key = localDateKey(date);
      recordsYear = date.getFullYear();
      recordsMonth = date.getMonth();
      document.getElementById("recordsDateFilter").value = key;
      document.getElementById("recordsDateLabel").textContent = new Intl.DateTimeFormat("es-VE", { weekday: "short", day: "numeric", month: "short", year: "numeric" }).format(date);
      document.querySelector("#openRecordsDatePicker .date-trigger-icon").textContent = String(date.getDate()).padStart(2, "0");
      recordsCalendarMonth = new Date(date.getFullYear(), date.getMonth(), 1);
      toggleRecordsDatePicker(false);
      renderRecords();
    }
    function clearRecordsDate() {
      document.getElementById("recordsDateFilter").value = "";
      document.getElementById("recordsDateLabel").textContent = "Todas las fechas";
      document.querySelector("#openRecordsDatePicker .date-trigger-icon").textContent = "31";
      recordsMonth = null;
      toggleRecordsDatePicker(false);
      renderRecords();
    }
    function toggleRecordsDatePicker(forceOpen) {
      const picker = document.getElementById("recordsDatePicker");
      const shouldOpen = forceOpen ?? picker.classList.contains("hidden");
      picker.classList.toggle("hidden", !shouldOpen);
      document.getElementById("openRecordsDatePicker").setAttribute("aria-expanded", String(shouldOpen));
      if (shouldOpen) {
        const selected = document.getElementById("recordsDateFilter").value;
        if (selected) { const date = new Date(`${selected}T12:00:00`); recordsCalendarMonth = new Date(date.getFullYear(), date.getMonth(), 1); }
        else recordsCalendarMonth = new Date(recordsYear, recordsMonth ?? new Date().getMonth(), 1);
        renderRecordsCalendar();
      }
    }
    function getFilteredInspections() {
      const selectedDate = document.getElementById("recordsDateFilter").value;
      const selectedRisk = document.getElementById("riskFilter").value;
      const query = document.getElementById("recordsSearchInput").value.trim().toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
      return state.inspections.filter(item => {
        const date = new Date(item.date);
        const searchable = [item.title, item.type, getInspectionMunicipality(item), item.address, item.description, item.inspectorName, item.organization].filter(Boolean).join(" ").toLocaleLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        return date.getFullYear() === recordsYear &&
          (recordsMonth === null || date.getMonth() === recordsMonth) &&
          (!selectedDate || localDateKey(date) === selectedDate) &&
          (selectedRisk === "all" || item.risk === selectedRisk) &&
          (!query || searchable.includes(query));
      }).sort((a, b) => new Date(b.date) - new Date(a.date));
    }
    function getInspectionSubmitter(inspection) {
      const profile = inspection.submittedByProfile || {};
      const user = state.users.find(item => item.id === inspection.createdBy) ||
        (currentUser?.id === inspection.createdBy ? currentUser : {});
      return {
        name: profile.name || inspection.submittedByName || user.name || inspection.inspectorName || "No especificado",
        cedula: profile.cedula || user.cedula || "",
        phone: profile.phone || user.phone || "",
        organization: profile.organization || user.organization || "",
        hierarchy: profile.hierarchy || user.hierarchy || "",
        email: profile.email || user.email || ""
      };
    }
    function getWhatsAppUrl(phone) {
      let digits = String(phone || "").replace(/\D/g, "");
      if (digits.startsWith("00")) digits = digits.slice(2);
      if (digits.startsWith("0")) digits = digits.slice(1);
      if (!digits.startsWith("58")) digits = `58${digits}`;
      return digits.length >= 11 && digits.length <= 15 ? `https://wa.me/${digits}` : "";
    }
    function getDirectionsUrl(latitude, longitude) {
      const params = new URLSearchParams({
        api: "1",
        destination: `${latitude},${longitude}`,
        travelmode: "driving"
      });
      return `https://www.google.com/maps/dir/?${params.toString()}`;
    }
    function printInspection(inspectionId) {
      const inspection = state.inspections.find(item => item.id === inspectionId);
      if (!inspection) { showToast("No se encontró la inspección para imprimir."); return; }
      const submitter = getInspectionSubmitter(inspection);
      const date = new Date(inspection.date);
      const format = (value, fallback = "No registrado") => value == null || value === "" ? fallback : String(value);
      const field = (label, value) => `<div class="print-field"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(format(value)).replace(/\n/g, "<br>")}</dd></div>`;
      const section = (title, fields) => `<section class="print-section"><h2>${escapeHtml(title)}</h2><dl>${fields}</dl></section>`;
      const whatsappUrl = getWhatsAppUrl(submitter.phone);
      const contact = [
        field("Nombre", submitter.name),
        field("Cédula", submitter.cedula),
        field("Jerarquía o cargo", submitter.hierarchy),
        field("Organización", submitter.organization),
        field("Teléfono registrado", submitter.phone),
        field("Correo registrado", submitter.email)
      ].join("");
      document.getElementById("printReport").innerHTML = `
        <header class="print-header"><div><p>PROTECCIÓN CIVIL · ESTADO APURE</p><h1>Formato de inspección</h1><strong>${escapeHtml(format(inspection.title))}</strong></div><div class="print-header-meta"><span>${escapeHtml(date.toLocaleDateString("es-VE"))}</span><span>${escapeHtml(date.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" }))}</span><span>${escapeHtml(format(riskNames[inspection.risk]))}</span></div></header>
        ${section("Identificación del evento", [
          field("Tipo de inspección", inspection.type),
          field("Nivel de riesgo", riskNames[inspection.risk]),
          field("Municipio", getInspectionMunicipality(inspection)),
          field("Dirección o referencia", inspection.address),
          field("Fecha y hora", date.toLocaleString("es-VE")),
          field("Fecha de registro", inspection.createdAt ? new Date(inspection.createdAt).toLocaleString("es-VE") : ""),
          field("Coordenadas", Number.isFinite(inspection.latitude) && Number.isFinite(inspection.longitude) ? `${inspection.latitude.toFixed(6)}, ${inspection.longitude.toFixed(6)}` : "")
        ].join(""))}
        ${section("Personal inspector", [
          field("Nombre completo", inspection.inspectorName),
          field("Cédula", inspection.inspectorCedula),
          field("Jerarquía o cargo", inspection.inspectorHierarchy),
          field("Organización", inspection.organization),
          field("Teléfono", inspection.inspectorPhone)
        ].join(""))}
        ${section("Afectaciones", [
          field("Personas afectadas", inspection.affectedPeople),
          field("Viviendas o estructuras afectadas", inspection.affectedStructures)
        ].join(""))}
        ${section("Evaluación y respuesta", [
          field("Hallazgos", inspection.description),
          field("Acciones realizadas", inspection.actionsTaken),
          field("Apoyo requerido y recomendaciones", inspection.supportRequired)
        ].join(""))}
        ${section("Registrado por", contact)}
        <footer class="print-footer"><span>Registro: ${escapeHtml(format(inspection.id))}</span><span>Generado el ${escapeHtml(new Date().toLocaleString("es-VE"))}</span>${whatsappUrl ? `<a href="${escapeHtml(whatsappUrl)}">WhatsApp del registrante: ${escapeHtml(submitter.phone)}</a>` : ""}</footer>`;
      window.addEventListener("afterprint", () => { document.getElementById("printReport").innerHTML = ""; }, { once: true });
      window.print();
    }
    function openUserProfile(userId, inspectionSnapshot = null) {
      const user = state.users.find(item => item.id === userId) ||
        (currentUser?.id === userId ? currentUser : null);
      const relatedInspections = state.inspections
        .filter(item => userId && item.createdBy === userId)
        .sort((a, b) => new Date(b.date) - new Date(a.date));
      const latestSnapshot = inspectionSnapshot || relatedInspections.find(item => item.submittedByProfile)?.submittedByProfile || {};
      const profile = {
        name: user?.name || latestSnapshot.name || relatedInspections.find(item => item.submittedByName)?.submittedByName || "Usuario",
        cedula: user?.cedula || latestSnapshot.cedula || "",
        phone: user?.phone || latestSnapshot.phone || "",
        organization: user?.organization || latestSnapshot.organization || "",
        hierarchy: user?.hierarchy || latestSnapshot.hierarchy || "",
        email: user?.email || latestSnapshot.email || ""
      };
      const whatsappUrl = getWhatsAppUrl(profile.phone);
      const profileField = (label, value) => `<div class="profile-detail"><small>${escapeHtml(label)}</small><strong>${escapeHtml(value || "No registrado")}</strong></div>`;
      const phoneHref = whatsappUrl || `tel:${String(profile.phone || "").replace(/[^+\d]/g, "")}`;
      const phoneLink = profile.phone
        ? `<a href="${escapeHtml(phoneHref)}" ${whatsappUrl ? 'target="_blank" rel="noopener noreferrer"' : ""}>${escapeHtml(profile.phone)}${whatsappUrl ? " · Escribir por WhatsApp" : ""}</a>`
        : "No registrado";
      const inspectionRows = relatedInspections.map(item => {
        const mapButton = Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
          ? `<button class="button map-record small" type="button" data-profile-map="${escapeHtml(item.id)}">Ver mapa</button>`
          : "";
        return `<article class="profile-inspection" data-profile-inspection="${escapeHtml(item.id)}"><span class="risk-tag ${escapeHtml(item.risk)}">${escapeHtml(riskNames[item.risk] || "Riesgo no clasificado")}</span><div><strong>${escapeHtml(item.title || "Inspección sin título")}</strong><small>${escapeHtml(item.type || "Tipo no registrado")} · ${escapeHtml(new Date(item.date).toLocaleDateString("es-VE"))} · ${escapeHtml(getInspectionMunicipality(item) || "Municipio no registrado")}</small></div>${mapButton}</article>`;
      }).join("");
      const inspectionList = inspectionRows
        ? `<div class="profile-inspection-list">${inspectionRows}</div>`
        : `<p class="profile-empty">Este usuario aún no tiene inspecciones registradas.</p>`;
      document.getElementById("userProfileTitle").textContent = profile.name;
      document.getElementById("userProfileBody").innerHTML = `
        <div class="profile-summary"><div class="profile-avatar" aria-hidden="true">${escapeHtml(profile.name.trim().slice(0, 1).toLocaleUpperCase() || "?")}</div><div><span>INSPECCIONES REGISTRADAS</span><strong>${relatedInspections.length}</strong></div></div>
        <div class="profile-details">
          ${profileField("Nombre completo", profile.name)}
          ${profileField("Cédula", profile.cedula)}
          ${profileField("Jerarquía o cargo", profile.hierarchy)}
          ${profileField("Organización", profile.organization)}
          <div class="profile-detail"><small>Teléfono</small><strong>${phoneLink}</strong></div>
          <div class="profile-detail"><small>Correo electrónico</small><strong>${profile.email ? `<a href="mailto:${escapeHtml(profile.email)}">${escapeHtml(profile.email)}</a>` : "No registrado"}</strong></div>
        </div>
        <section class="profile-inspections"><h3>Inspecciones realizadas <span>${relatedInspections.length}</span></h3>${inspectionList}</section>`;
      document.getElementById("userProfileModal").classList.remove("hidden");
    }
    function closeUserProfile() {
      document.getElementById("userProfileModal").classList.add("hidden");
    }
    function renderRecordsOverview() {
      const yearSelect = document.getElementById("recordsYearFilter");
      const years = Array.from(new Set([new Date().getFullYear(), ...state.inspections.map(item => new Date(item.date).getFullYear())])).sort((a, b) => b - a);
      if (!years.includes(recordsYear)) years.push(recordsYear);
      yearSelect.innerHTML = years.map(year => `<option value="${year}">${year}</option>`).join("");
      yearSelect.value = String(recordsYear);
      const yearItems = state.inspections.filter(item => new Date(item.date).getFullYear() === recordsYear);
      const counts = { high: 0, medium: 0, safe: 0 };
      yearItems.forEach(item => { if (counts[item.risk] !== undefined) counts[item.risk]++; });
      const inspectors = new Set(yearItems.map(item => item.inspectorName).filter(Boolean)).size;
      const locations = new Set(yearItems.map(item => (item.address || "").trim() || (Number.isFinite(item.latitude) && Number.isFinite(item.longitude) ? `${item.latitude.toFixed(5)},${item.longitude.toFixed(5)}` : "")).filter(Boolean)).size;
      document.getElementById("recordsSummary").innerHTML = `
        <article class="summary-card"><span>Total de inspecciones</span><strong>${yearItems.length}</strong><small>Año ${recordsYear}</small></article>
        <article class="summary-card high"><span>Alto riesgo</span><strong>${counts.high}</strong><small>Atención prioritaria</small></article>
        <article class="summary-card medium"><span>Riesgo medio</span><strong>${counts.medium}</strong><small>Seguimiento preventivo</small></article>
        <article class="summary-card safe"><span>Seguro / bajo</span><strong>${counts.safe}</strong><small>Condición estable</small></article>
        <article class="summary-card"><span>Inspectores</span><strong>${inspectors}</strong><small>Personal registrado</small></article>
        <article class="summary-card"><span>Ubicaciones</span><strong>${locations}</strong><small>Sitios identificados</small></article>`;
      const monthCounts = Array(12).fill(0);
      yearItems.forEach(item => monthCounts[new Date(item.date).getMonth()]++);
      document.getElementById("recordsMonths").innerHTML = monthNames.map((month, index) =>
        `<button class="month-card${recordsMonth === index ? " active" : ""}" type="button" data-record-month="${index}" aria-pressed="${recordsMonth === index}"><span>${month}</span><strong>${monthCounts[index]}</strong><small>${monthCounts[index] === 1 ? "inspección" : "inspecciones"}</small></button>`
      ).join("");
      document.getElementById("showAllMonths").classList.toggle("active", recordsMonth === null);
    }
    function renderRecords() {
      renderRecordsOverview();
      const filtered = getFilteredInspections();
      const groups = new Map();
      filtered.forEach(item => { const key = localDateKey(new Date(item.date)); if (!groups.has(key)) groups.set(key, []); groups.get(key).push(item); });
      const timeline = document.getElementById("timeline");
      if (!groups.size) { timeline.innerHTML = `<div class="empty-state">No hay inspecciones para estos filtros.</div>`; return; }
      timeline.innerHTML = Array.from(groups, ([key, items]) => {
        const date = new Date(`${key}T12:00:00`);
        const heading = new Intl.DateTimeFormat("es-VE", { weekday: "long", day: "2-digit", month: "long", year: "numeric" }).format(date);
        const records = items.map(item => {
          const time = new Date(item.date).toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit" });
          const canEdit = canEditInspection(item);
          const submitter = getInspectionSubmitter(item);
          const whatsappUrl = getWhatsAppUrl(submitter.phone);
          const directionsLink = Number.isFinite(item.latitude) && Number.isFinite(item.longitude)
            ? `<a class="button route-record small" href="${escapeHtml(getDirectionsUrl(item.latitude, item.longitude))}" target="_blank" rel="noopener noreferrer">↗ Cómo llegar</a>`
            : "";
          return `<article class="inspection-item" data-risk="${item.risk}" data-inspection-id="${escapeHtml(item.id)}">
            <div class="inspection-card-main">
              <div class="inspection-card-top"><div class="inspection-badges"><span class="risk-tag ${item.risk}">${riskNames[item.risk]}</span><span class="inspection-type-tag">${escapeHtml(item.type)}</span><span class="inspection-time">◷ ${time}</span></div>
                <div class="inspection-card-actions">${canEdit ? `<button class="button small edit-record" type="button" data-record-action="edit">Editar</button><button class="button danger small" type="button" data-record-action="delete">Eliminar</button>` : ""}${directionsLink}<button class="button map-record small" type="button" data-record-action="map" ${Number.isFinite(item.latitude) && Number.isFinite(item.longitude) ? "" : "disabled"}>⌖ Ver en mapa</button><button class="button ficha-record small" type="button" data-record-action="details" aria-expanded="false">Ficha completa</button><button class="button print-record small" type="button" data-record-action="print">▤ Imprimir</button></div>
              </div>
              <h3>${escapeHtml(item.title)}</h3>
              <div class="inspection-facts"><div><small>MUNICIPIO</small><strong>${escapeHtml(getInspectionMunicipality(item) || "No registrado")}</strong><span>${escapeHtml(item.address || "Sin referencia de dirección")}<br>${Number.isFinite(item.latitude) && Number.isFinite(item.longitude) ? `${item.latitude.toFixed(5)}, ${item.longitude.toFixed(5)}` : "Sin coordenadas"}</span></div>
                <div><small>INSPECCIÓN REALIZADA POR</small><strong>${escapeHtml(item.inspectorName || "No especificado")}</strong><span>${escapeHtml([item.inspectorHierarchy, item.organization].filter(Boolean).join(" · ") || item.inspectorPhone || "Sin institución registrada")}</span><button class="inspection-author-link" type="button" data-record-action="profile">Registró: ${escapeHtml(submitter.name)} · Ver perfil</button></div>
              </div>
              <div class="inspection-impact-strip"><span><small>PERSONAS AFECTADAS</small><strong>${item.affectedPeople == null ? "Sin dato" : escapeHtml(item.affectedPeople)}</strong></span><span><small>VIVIENDAS / ESTRUCTURAS</small><strong>${item.affectedStructures == null ? "Sin dato" : escapeHtml(item.affectedStructures)}</strong></span></div>
              <div class="inspection-notes"><strong>Hallazgos de la inspección</strong><p>${escapeHtml(item.description || "Sin observaciones registradas.")}</p></div>
              <div class="inspection-full-details hidden"><span><small>Cédula del inspector</small><strong>${escapeHtml(item.inspectorCedula || "No registrada")}</strong></span><span><small>Teléfono del inspector</small><strong>${escapeHtml(item.inspectorPhone || "No registrado")}</strong></span><span><small>Fecha y hora</small><strong>${new Date(item.date).toLocaleString("es-VE")}</strong></span><span><small>Referencia</small><strong>${escapeHtml(item.address || "No registrada")}</strong></span><span><small>Registró la inspección</small><strong>${escapeHtml(submitter.name)}</strong></span><span><small>Cédula del registrante</small><strong>${escapeHtml(submitter.cedula || "No registrada")}</strong></span><span><small>Jerarquía y organización</small><strong>${escapeHtml([submitter.hierarchy, submitter.organization].filter(Boolean).join(" · ") || "No registradas")}</strong></span><span><small>Teléfono registrado</small><strong>${whatsappUrl ? `<a class="submitter-phone" href="${escapeHtml(whatsappUrl)}" target="_blank" rel="noopener noreferrer" aria-label="Escribir por WhatsApp a ${escapeHtml(submitter.name)}">${escapeHtml(submitter.phone)} · WhatsApp</a>` : escapeHtml(submitter.phone || "No registrado")}</strong></span><span><small>Correo registrado</small><strong>${submitter.email ? `<a href="mailto:${escapeHtml(submitter.email)}">${escapeHtml(submitter.email)}</a>` : "No registrado"}</strong></span><span><small>Acciones realizadas</small><strong>${escapeHtml(item.actionsTaken || "No registradas")}</strong></span><span><small>Apoyo y recomendaciones</small><strong>${escapeHtml(item.supportRequired || "No registrados")}</strong></span></div>
            </div>
          </article>`;
        }).join("");
        return `<section class="day-group"><header class="day-date"><span class="day-date-dot"></span><strong>${heading}</strong><small>${items.length} ${items.length === 1 ? "inspección" : "inspecciones"}</small></header><div class="inspection-list">${records}</div></section>`;
      }).join("");
    }
    function renderAdmin() {
      document.getElementById("pendingList").innerHTML = state.users.filter(user => user.status === "pending").map(user => `<div class="admin-row"><div><strong>${escapeHtml(user.name)}</strong><small>${escapeHtml(user.username)} · C.I. ${escapeHtml(user.cedula || "No registrada")} · ${escapeHtml(user.phone || "Sin teléfono")}${user.organization ? ` · ${escapeHtml(user.organization)}` : ""}${user.hierarchy ? ` · ${escapeHtml(user.hierarchy)}` : ""}</small></div><div class="row-actions"><button class="button small" data-approve="${user.id}">Aprobar</button><button class="button danger small" data-reject="${user.id}">Rechazar</button></div></div>`).join("") || `<div class="empty-state">No hay solicitudes pendientes.</div>`;
      document.getElementById("usersList").innerHTML = state.users.filter(user => user.status === "approved").map(user => `<div class="admin-row"><div><strong>${escapeHtml(user.name)}</strong><small>${user.role === "admin" ? "Administrador" : "Usuario"} · ${escapeHtml(user.username)}${user.organization ? ` · ${escapeHtml(user.organization)}` : ""}${user.hierarchy ? ` · ${escapeHtml(user.hierarchy)}` : ""}</small></div><div class="row-actions"><button class="button secondary small" data-user-profile="${escapeHtml(user.id)}">Ver perfil</button>${user.role !== "admin" ? `<button class="button ghost small" data-disable="${escapeHtml(user.id)}">Desactivar</button>` : ""}</div></div>`).join("");
      document.getElementById("inviteList").innerHTML = state.invitations.map(invite => `<div class="admin-row"><div><strong class="mono">${escapeHtml(invite.code)}</strong><small>${invite.used ? "Usada" : "Disponible"} · ${new Date(invite.createdAt).toLocaleDateString("es-VE")}</small></div></div>`).join("") || `<div class="empty-state">Aún no hay invitaciones.</div>`;
    }
    function showToast(text) {
      const toast = document.getElementById("toast"); toast.textContent = text; toast.classList.remove("hidden");
      clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.add("hidden"), 3200);
    }
    function downloadTextFile(filename, content, type) {
      const url = URL.createObjectURL(new Blob([content], { type }));
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function csvCell(value) {
      let text = String(value ?? "");
      if (/^\s*[=+\-@]/.test(text)) text = `'${text}`;
      return `"${text.replace(/"/g, '""')}"`;
    }
    function exportInspectionsCsv() {
      const inspections = getFilteredInspections();
      if (!inspections.length) { showToast("No hay inspecciones para exportar con estos filtros."); return; }
      const columns = ["Fecha", "Hora", "Lugar", "Municipio", "Estado", "Riesgo", "Tipo", "Dirección", "Hallazgos", "Personas afectadas", "Viviendas o estructuras afectadas", "Acciones realizadas", "Apoyo requerido y recomendaciones", "Inspector", "Cédula del inspector", "Jerarquía o cargo", "Teléfono", "Institución", "Registró", "Latitud", "Longitud"];
      const rows = inspections.map(item => {
        const date = new Date(item.date);
        const municipality = getInspectionMunicipality(item);
        return [localDateKey(date), date.toLocaleTimeString("es-VE", { hour: "2-digit", minute: "2-digit", hour12: false }), item.title, municipality, municipality ? "Apure" : "", riskNames[item.risk], item.type, item.address, item.description, item.affectedPeople, item.affectedStructures, item.actionsTaken, item.supportRequired, item.inspectorName, item.inspectorCedula, item.inspectorHierarchy, item.inspectorPhone, item.organization, item.submittedByName || item.inspectorName, item.latitude, item.longitude];
      });
      const csv = [columns, ...rows].map(row => row.map(csvCell).join(";")).join("\r\n");
      downloadTextFile(`inspecciones-${localDateKey(new Date())}.csv`, `\uFEFF${csv}`, "text/csv;charset=utf-8");
      showToast("Archivo CSV de inspecciones descargado.");
    }
    function exportDataBackup() {
      const inspections = state.inspections.map(({ createdBy, ...item }) => item);
      const referencePlaces = state.referencePlaces.map(({ createdBy, ...place }) => place);
      const backup = { format: "territorio-seguro-backup", version: 1, exportedAt: new Date().toISOString(), inspections, referencePlaces };
      const json = JSON.stringify(backup, null, 2);
      downloadTextFile(`respaldo-territorio-seguro-${localDateKey(new Date())}.json`, json, "application/json;charset=utf-8");
      document.getElementById("backupMessage").textContent = "Respaldo descargado. Guárdalo en un lugar seguro.";
      document.getElementById("backupMessage").classList.add("success");
    }
    async function importDataBackup(event) {
      const file = event.target.files?.[0];
      const message = document.getElementById("backupMessage");
      message.classList.remove("success");
      if (!file) return;
      if (!sharedDataReady) { message.textContent = "Espera a que terminen de cargar los datos antes de restaurar un respaldo."; event.target.value = ""; return; }
      try {
        if (file.size > 10 * 1024 * 1024) throw new Error("El archivo supera el límite de 10 MB.");
        const backup = JSON.parse(await file.text());
        if (backup.format !== "territorio-seguro-backup" || backup.version !== 1 || !Array.isArray(backup.inspections) || !Array.isArray(backup.referencePlaces)) throw new Error("El archivo no es un respaldo válido de Territorio Seguro.");
        const validInspections = backup.inspections.every(item => item && typeof item.id === "string" && typeof item.title === "string" && Number.isFinite(new Date(item.date).getTime()) && Boolean(riskNames[item.risk]) && Number.isFinite(Number(item.latitude)) && Number.isFinite(Number(item.longitude)));
        const validPlaces = backup.referencePlaces.every(place => place && typeof place.id === "string" && typeof place.name === "string" && Number.isFinite(Number(place.latitude)) && Number.isFinite(Number(place.longitude)));
        if (!validInspections || !validPlaces) throw new Error("El respaldo contiene datos incompletos o inválidos.");
        const inspectionsWithinApure = backup.inspections.every(item => {
          const municipality = getApureMunicipality(Number(item.latitude), Number(item.longitude));
          return municipality && (!item.municipality || item.municipality === municipality);
        });
        if (!inspectionsWithinApure) throw new Error("El respaldo incluye inspecciones fuera de los municipios de Apure o con un municipio que no coincide con las coordenadas.");
        if (!confirm(`Se reemplazarán ${state.inspections.length} inspecciones y ${state.referencePlaces.length} lugares por ${backup.inspections.length} inspecciones y ${backup.referencePlaces.length} lugares del respaldo. Las cuentas no cambiarán. ¿Continuar?`)) return;
        state.inspections = backup.inspections.map(item => {
          const latitude = Number(item.latitude);
          const longitude = Number(item.longitude);
          return { ...item, latitude, longitude, municipality: getApureMunicipality(latitude, longitude) };
        });
        state.referencePlaces = backup.referencePlaces;
        saveState();
        renderMarkers();
        renderRecords();
        message.textContent = "Respaldo cargado; sincronizando con Firebase. Las cuentas se conservaron.";
      } catch (error) {
        message.textContent = error.message || "No se pudo leer el archivo de respaldo.";
      } finally {
        event.target.value = "";
      }
    }
    document.querySelectorAll(".nav-button").forEach(button => button.addEventListener("click", () => showView(button.dataset.view)));
    document.getElementById("recordsBackToMap").addEventListener("click", () => showView("mapView"));
    document.getElementById("recordsYearFilter").addEventListener("change", event => {
      recordsYear = Number(event.target.value);
      recordsMonth = null;
      recordsCalendarMonth = new Date(recordsYear, new Date().getMonth(), 1);
      document.getElementById("recordsDateFilter").value = "";
      document.getElementById("recordsDateLabel").textContent = "Todas las fechas";
      document.querySelector("#openRecordsDatePicker .date-trigger-icon").textContent = "31";
      renderRecords();
    });
    document.getElementById("showAllMonths").addEventListener("click", clearRecordsDate);
    document.getElementById("recordsMonths").addEventListener("click", event => {
      const button = event.target.closest("[data-record-month]");
      if (!button) return;
      recordsMonth = Number(button.dataset.recordMonth);
      document.getElementById("recordsDateFilter").value = "";
      document.getElementById("recordsDateLabel").textContent = "Todas las fechas";
      document.querySelector("#openRecordsDatePicker .date-trigger-icon").textContent = "31";
      renderRecords();
    });
    document.getElementById("recordsSearchInput").addEventListener("input", renderRecords);
    document.getElementById("timeline").addEventListener("click", event => {
      const button = event.target.closest("[data-record-action]");
      if (!button) return;
      const card = button.closest("[data-inspection-id]");
      const inspection = state.inspections.find(item => item.id === card?.dataset.inspectionId);
      if (!inspection) return;
      if (button.dataset.recordAction === "edit") {
        if (canEditInspection(inspection)) openReport(inspection);
      } else if (button.dataset.recordAction === "delete") {
        deleteInspection(inspection.id);
      } else if (button.dataset.recordAction === "details") {
        const details = card.querySelector(".inspection-full-details");
        const expanded = details.classList.contains("hidden");
        details.classList.toggle("hidden", !expanded);
        card.querySelectorAll('[data-record-action="details"]').forEach(detailsButton => detailsButton.setAttribute("aria-expanded", String(expanded)));
      } else if (button.dataset.recordAction === "profile") {
        openUserProfile(inspection.createdBy, inspection.submittedByProfile);
      } else if (button.dataset.recordAction === "print") {
        printInspection(inspection.id);
      } else if (button.dataset.recordAction === "map") {
        if (!Number.isFinite(inspection.latitude) || !Number.isFinite(inspection.longitude)) return;
        selectMapDate(localDateKey(new Date(inspection.date)));
        const riskFilter = document.querySelector(`[data-filter="${inspection.risk}"]`);
        if (riskFilter) riskFilter.checked = true;
        renderMarkers();
        showView("mapView");
        focusMapPoint(inspection.latitude, inspection.longitude);
        const marker = markers.find(item => item.options.inspectionId === inspection.id);
        if (marker) setTimeout(() => marker.openPopup(), 100);
      }
    });
    document.getElementById("logoutButton").addEventListener("click", async () => {
      try {
        await firebaseAuth.signOut();
        map?.remove(); map = null; baseLayer = null; markers = [];
      } catch (error) {
        console.error("No se pudo cerrar la sesión de Firebase.", error);
        showToast("No se pudo cerrar la sesión. Inténtalo de nuevo.");
      }
    });
    document.getElementById("openReport").addEventListener("click", () => openReport());
    document.getElementById("openReportFromRecords").addEventListener("click", () => openReport());
    document.getElementById("openDatePicker").addEventListener("click", () => toggleDatePicker());
    document.getElementById("previousMonth").addEventListener("click", () => { calendarMonth.setMonth(calendarMonth.getMonth() - 1); renderInspectionCalendar(); });
    document.getElementById("nextMonth").addEventListener("click", () => { calendarMonth.setMonth(calendarMonth.getMonth() + 1); renderInspectionCalendar(); });
    document.getElementById("selectToday").addEventListener("click", () => setInspectionDate(new Date()));
    document.getElementById("calendarDays").addEventListener("click", event => {
      const dayButton = event.target.closest("[data-day]");
      if (!dayButton) return;
      event.stopPropagation();
      const [hours, minutes] = (document.getElementById("inspectionTime").value || "00:00").split(":").map(Number);
      setInspectionDate(new Date(calendarMonth.getFullYear(), calendarMonth.getMonth(), Number(dayButton.dataset.day), hours, minutes));
    });
    document.getElementById("inspectionTime").addEventListener("change", event => {
      const dateValue = document.getElementById("inspectionDate").value;
      if (!dateValue || !event.target.value) return;
      const updatedDate = new Date(dateValue);
      const [hours, minutes] = event.target.value.split(":").map(Number);
      updatedDate.setHours(hours, minutes);
      setInspectionDate(updatedDate);
    });
    document.getElementById("openRecordsDatePicker").addEventListener("click", () => { toggleDatePicker(false); toggleRecordsDatePicker(); });
    document.getElementById("previousRecordsMonth").addEventListener("click", () => { recordsCalendarMonth.setMonth(recordsCalendarMonth.getMonth() - 1); renderRecordsCalendar(); });
    document.getElementById("nextRecordsMonth").addEventListener("click", () => { recordsCalendarMonth.setMonth(recordsCalendarMonth.getMonth() + 1); renderRecordsCalendar(); });
    document.getElementById("recordsCalendarDays").addEventListener("click", event => {
      const dayButton = event.target.closest("[data-record-day]");
      if (!dayButton) return;
      event.stopPropagation();
      setRecordsDate(new Date(recordsCalendarMonth.getFullYear(), recordsCalendarMonth.getMonth(), Number(dayButton.dataset.recordDay)));
    });
    document.getElementById("clearRecordDate").addEventListener("click", clearRecordsDate);
    document.getElementById("openPlace").addEventListener("click", () => openPlaceForm());
    document.getElementById("closeReport").addEventListener("click", closeReport);
    document.getElementById("cancelReport").addEventListener("click", closeReport);
    document.getElementById("reportForm").addEventListener("submit", saveInspection);
    document.getElementById("inspectionTitle").addEventListener("input", () => { inspectionTitleEdited = true; });
    document.getElementById("inspectionAddress").addEventListener("input", () => { inspectionAddressEdited = true; });
    document.getElementById("getGps").addEventListener("click", useGPS);
    document.getElementById("pickOnMap").addEventListener("click", () => {
      if (!map) { document.getElementById("reportMessage").textContent = "El mapa aún no está disponible."; return; }
      startMapPick({ modalId: "reportModal", latitudeId: "latitude", longitudeId: "longitude", coordsLabelId: "coordsLabel" });
    });
    document.getElementById("closePlace").addEventListener("click", closePlaceForm);
    document.getElementById("cancelPlace").addEventListener("click", closePlaceForm);
    document.getElementById("placeForm").addEventListener("submit", saveReferencePlace);
    document.getElementById("getPlaceGps").addEventListener("click", () => useGPS({ latitudeId: "placeLatitude", longitudeId: "placeLongitude", coordsLabelId: "placeCoordsLabel", messageId: "placeMessage" }));
    document.getElementById("pickPlaceOnMap").addEventListener("click", () => {
      if (!map) { document.getElementById("placeMessage").textContent = "El mapa aún no está disponible."; return; }
      startMapPick({ modalId: "placeModal", latitudeId: "placeLatitude", longitudeId: "placeLongitude", coordsLabelId: "placeCoordsLabel" });
    });
    document.querySelectorAll("[data-filter]").forEach(input => input.addEventListener("change", renderMarkers));
    document.getElementById("zoomApure").addEventListener("click", () => {
      if (apureMunicipalityLayer) map?.fitBounds(apureMunicipalityLayer.getBounds(), { padding: [30, 30] });
      else showToast("Los límites municipales de Apure todavía se están cargando.");
    });
    document.getElementById("municipalityLegend").addEventListener("click", event => {
      const button = event.target.closest("[data-municipality]");
      if (button) zoomToMunicipality(button.dataset.municipality);
    });
    document.getElementById("inspectionMunicipality").addEventListener("change", event => {
      if (event.target.value) zoomToMunicipality(event.target.value);
    });
    document.getElementById("mapDatePrevious").addEventListener("click", () => shiftMapDateWindow(-1));
    document.getElementById("mapDateNext").addEventListener("click", () => shiftMapDateWindow(1));
    document.getElementById("mapDateDays").addEventListener("click", event => {
      const dayButton = event.target.closest("[data-map-date]");
      if (dayButton) selectMapDate(dayButton.dataset.mapDate);
    });
    document.getElementById("mapDateInput").addEventListener("change", event => {
      if (event.target.value) selectMapDate(event.target.value);
    });
    document.getElementById("mapDateAll").addEventListener("click", () => {
      selectedMapDate = "";
      mapDateWindowOffset = 0;
      renderMarkers();
    });
    function setMapToolsExpanded(expanded) {
      const toggle = document.getElementById("toggleMapTools");
      toggle.setAttribute("aria-expanded", String(expanded));
      document.getElementById("mapToolsContent").classList.toggle("hidden", !expanded);
      document.querySelector(".map-tools").classList.toggle("is-collapsed", !expanded);
    }
    document.getElementById("toggleMapTools").addEventListener("click", event => {
      const toggle = event.currentTarget;
      const expanded = toggle.getAttribute("aria-expanded") === "true";
      mapToolsManuallyToggled = true;
      setMapToolsExpanded(!expanded);
    });
    const mapToolsBreakpoint = window.matchMedia("(max-width: 760px)");
    const handleMapToolsBreakpoint = event => {
      if (!mapToolsManuallyToggled) setMapToolsExpanded(!event.matches);
    };
    if (mapToolsBreakpoint.addEventListener) mapToolsBreakpoint.addEventListener("change", handleMapToolsBreakpoint);
    else mapToolsBreakpoint.addListener(handleMapToolsBreakpoint);
    document.getElementById("mapLayerSelect").addEventListener("change", event => setBaseLayer(event.target.value));
    document.getElementById("mapSearchForm").addEventListener("submit", event => {
      event.preventDefault();
      searchMapPlaces(document.getElementById("mapSearchInput").value);
    });
    document.addEventListener("click", event => {
      if (!event.target.closest(".map-search")) document.getElementById("searchResults").classList.add("hidden");
      if (!event.target.closest(".date-field")) { toggleDatePicker(false); toggleRecordsDatePicker(false); }
    });
    document.getElementById("locateMe").addEventListener("click", () => {
      if (!navigator.geolocation) { showToast("El navegador no permite geolocalización."); return; }
      navigator.geolocation.getCurrentPosition(position => {
        if (!getApureMunicipality(position.coords.latitude, position.coords.longitude)) {
          showToast("Tu ubicación está fuera de Apure; el mapa permanece enfocado en el estado.");
          return;
        }
        map?.setView([position.coords.latitude, position.coords.longitude], 14);
        showToast("Ubicación actual encontrada.");
      }, () => showToast("No se pudo obtener la ubicación. Revisa los permisos del navegador."), { enableHighAccuracy: true, timeout: 12000 });
    });
    document.getElementById("riskFilter").addEventListener("change", renderRecords);
    document.getElementById("clearFilters").addEventListener("click", () => {
      document.getElementById("riskFilter").value = "all";
      document.getElementById("recordsSearchInput").value = "";
      recordsYear = new Date().getFullYear();
      recordsMonth = null;
      clearRecordsDate();
    });
    document.getElementById("exportRecordsCsv").addEventListener("click", exportInspectionsCsv);
    document.getElementById("exportBackup").addEventListener("click", exportDataBackup);
    document.getElementById("importBackupFile").addEventListener("change", importDataBackup);
    document.getElementById("generateInvite").addEventListener("click", async () => {
      const code = `PC-${crypto.randomUUID().replace(/-/g, "").slice(0, 24).toUpperCase()}`;
      const invitation = { used: false, createdAt: new Date().toISOString(), createdBy: currentUser.id };
      try {
        await firebaseDatabase.ref(`territorioSeguro/invitations/${code}`).set(invitation);
        state.invitations.push({ code, ...invitation });
        document.getElementById("inviteCode").value = code;
        renderAdmin();
      } catch (error) {
        console.error("No se pudo guardar la invitación.", error);
        showToast("No se pudo guardar la invitación en Firebase.");
      }
    });
    document.getElementById("copyInvite").addEventListener("click", async () => {
      const code = document.getElementById("inviteCode").value;
      if (!code) { showToast("Genera una invitación primero."); return; }
      try { await navigator.clipboard.writeText(code); showToast("Código copiado."); } catch { document.getElementById("inviteCode").select(); showToast("Selecciona y copia el código."); }
    });
    document.getElementById("adminView").addEventListener("click", async event => {
      const profileId = event.target.closest("[data-user-profile]")?.dataset.userProfile;
      if (profileId) { openUserProfile(profileId); return; }
      const approveId = event.target.dataset.approve; const rejectId = event.target.dataset.reject; const disableId = event.target.dataset.disable;
      const user = state.users.find(item => item.id === (approveId || rejectId || disableId));
      if (!user) return;
      try {
        const profileRef = firebaseDatabase.ref(`territorioSeguro/profiles/${user.id}`);
        if (approveId) await profileRef.update({ status: "approved" });
        else await profileRef.remove();
        showToast(approveId ? "Cuenta aprobada." : "Cuenta eliminada.");
      } catch (error) {
        console.error("No se pudo actualizar el acceso de la cuenta.", error);
        showToast("No se pudo actualizar la cuenta. Verifica los permisos de Firebase.");
      }
    });
    document.getElementById("closeUserProfile").addEventListener("click", closeUserProfile);
    document.getElementById("userProfileModal").addEventListener("click", event => {
      if (event.target.id === "userProfileModal") { closeUserProfile(); return; }
      const mapButton = event.target.closest("[data-profile-map]");
      if (!mapButton) return;
      const inspection = state.inspections.find(item => item.id === mapButton.dataset.profileMap);
      if (!inspection || !Number.isFinite(inspection.latitude) || !Number.isFinite(inspection.longitude)) return;
      closeUserProfile();
      selectMapDate(localDateKey(new Date(inspection.date)));
      const riskFilter = document.querySelector(`[data-filter="${inspection.risk}"]`);
      if (riskFilter) riskFilter.checked = true;
      renderMarkers();
      showView("mapView");
      focusMapPoint(inspection.latitude, inspection.longitude);
      const marker = markers.find(item => item.options.inspectionId === inspection.id);
      if (marker) setTimeout(() => marker.openPopup(), 100);
    });
    document.getElementById("reportModal").addEventListener("click", event => { if (event.target.id === "reportModal") closeReport(); });
    document.getElementById("placeModal").addEventListener("click", event => { if (event.target.id === "placeModal") closePlaceForm(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") { closeReport(); closePlaceForm(); closePointChoice(); closeUserProfile(); toggleDatePicker(false); toggleRecordsDatePicker(false); } });
    firebaseAuth?.onAuthStateChanged(handleAuthState, error => {
      console.error("No se pudo validar la sesión de Firebase.", error);
      showAuth();
    });
    showAuth();
