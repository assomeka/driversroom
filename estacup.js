import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  query,
  where,
  getDocs,
  doc,
  setDoc,
  updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDJ7uhvc31nyRB4bh9bVtkagaUksXG1fOo",
  authDomain: "estacupbymeka.firebaseapp.com",
  projectId: "estacupbymeka",
  storageBucket: "estacupbymeka.appspot.com",
  messagingSenderId: "1065406380441",
  appId: "1:1065406380441:web:55005f7d29290040c13b08"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// DOM
const $ = (id) => document.getElementById(id);
const formCard = $("formCard");
const formTitle = $("formTitle");
const alreadyBlock = $("alreadyBlock");
const alreadyText = $("alreadyText");
const btnEdit = $("btnEdit");
const btnCancelEdit = $("btnCancelEdit");
const takenNumbers = $("takenNumbers");

const f_first = $("firstName");
const f_last  = $("lastName");
const f_age   = $("age");
const f_email = $("email");
const f_team  = $("teamName");
const f_car   = $("carChoice");
const f_num   = $("raceNumber");
const f_livery= $("liveryChoice");
const colorsRow = $("colors");
const c1 = $("color1");
const c2 = $("color2");
const c3 = $("color3");
const btnSave = $("btnSave");
const btnLogout = $("logout");

let currentId = null;

// helpers
const show = (el) => el && el.classList.remove("hidden");
const hide = (el) => el && el.classList.add("hidden");

function fillForm(d = {}) {
  f_first.value = d.firstName ?? "";
  f_last.value  = d.lastName ?? "";
  f_age.value   = d.age ?? "";
  f_email.value = d.email ?? "";
  f_team.value  = d.teamName ?? "";
  f_car.value   = d.carChoice ?? "";
  f_num.value   = d.raceNumber ?? "";
  f_livery.value = d.liveryChoice ?? "Livrée perso";

  const semi = (d.liveryChoice ?? "") === "Livrée semi-perso";
  if (semi) {
    show(colorsRow);
    c1.value = d.liveryColors?.color1 || "#000000";
    c2.value = d.liveryColors?.color2 || "#01234A";
    c3.value = d.liveryColors?.color3 || "#6BDAEC";
  } else {
    hide(colorsRow);
  }
}

async function loadTakenNumbers() {
  takenNumbers.innerHTML = "";
  const snap = await getDocs(collection(db, "estacup_signups"));
  snap.forEach((docu) => {
    const n = docu.data().raceNumber;
    if (n) {
      const div = document.createElement("div");
      div.className = "num taken";
      div.textContent = n;
      takenNumbers.appendChild(div);
    }
  });
}

// init
onAuthStateChanged(auth, async (user) => {
  if (!user) return (window.location.href = "login.html");

  // cherche une inscription existante
  const q = query(collection(db, "estacup_signups"), where("uid", "==", user.uid));
  const snap = await getDocs(q);

  if (snap.empty) {
    // pas d'inscription → montrer le formulaire
    formTitle.textContent = "Nouvelle inscription";
    fillForm();
    hide(alreadyBlock);
    show(formCard);
  } else {
    // inscription trouvée → montrer le bloc résumé et cacher le formulaire
    const ref = snap.docs[0];
    currentId = ref.id;
    const d = ref.data();

    const status = d.validated ? "✅ Validée" : "⏳ En attente";
    alreadyText.innerHTML = `Vous êtes déjà inscrit.<br/>Statut : <b>${status}</b>`;
    show(alreadyBlock);

    fillForm(d);          // pré-remplir pour l’édition
    hide(formCard);       // formulaire caché tant qu’on n’appuie pas sur “Modifier”
    formTitle.textContent = "Modifier mon inscription";
  }

  await loadTakenNumbers();
});

// events
btnLogout?.addEventListener("click", () => {
  signOut(auth).then(() => (window.location.href = "login.html"));
});

f_livery?.addEventListener("change", (e) => {
  if (e.target.value === "Livrée semi-perso") show(colorsRow);
  else hide(colorsRow);
});

btnEdit?.addEventListener("click", () => {
  show(formCard);
  hide(alreadyBlock);
  show(btnCancelEdit);
});

btnCancelEdit?.addEventListener("click", () => {
  hide(formCard);
  show(alreadyBlock);
  hide(btnCancelEdit);
});

btnSave?.addEventListener("click", async () => {
  const user = auth.currentUser;
  if (!user) return;

  // parse numéro
  const raw = f_num.value.trim();
  const num = raw === "" ? null : parseInt(raw, 10);
  if (num !== null && (isNaN(num) || num < 1 || num > 999)) {
    alert("N° invalide (1–999).");
    return;
  }

  // unicité
  if (num !== null) {
    const q = query(collection(db, "estacup_signups"), where("raceNumber", "==", num));
    const s = await getDocs(q);
    if (!s.empty) {
      const conflict = s.docs.find((x) => x.id !== currentId);
      if (conflict) {
        alert("Ce numéro est déjà pris.");
        return;
      }
    }
  }

  const data = {
    uid: user.uid,
    firstName: f_first.value.trim(),
    lastName:  f_last.value.trim(),
    age: f_age.value ? parseInt(f_age.value, 10) : null,
    email: f_email.value.trim(),
    teamName: f_team.value.trim(),
    carChoice: f_car.value.trim(),
    raceNumber: num,
    liveryChoice: f_livery.value,
    validated: false // toute création/édition dévalide
  };

  if (data.liveryChoice === "Livrée semi-perso") {
    data.liveryColors = {
      color1: c1.value,
      color2: c2.value,
      color3: c3.value
    };
  } else {
    data.liveryColors = null;
  }

  try {
    if (currentId) {
      await updateDoc(doc(db, "estacup_signups", currentId), data);
    } else {
      const newRef = doc(collection(db, "estacup_signups"));
      await setDoc(newRef, data);
      currentId = newRef.id;
    }

    alert("Inscription enregistrée. Elle devra être validée par un admin.");

    // retour au résumé
    const status = data.validated ? "✅ Validée" : "⏳ En attente";
    alreadyText.innerHTML = `Vous êtes déjà inscrit.<br/>Statut : <b>${status}</b>`;
    hide(formCard);
    show(alreadyBlock);
    hide(btnCancelEdit);

    await loadTakenNumbers();
  } catch (e) {
    console.error(e);
    alert("Erreur lors de l'enregistrement.");
  }
});