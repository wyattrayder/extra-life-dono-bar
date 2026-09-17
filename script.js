const participantId = "565898";

const POLL_INTERVAL = 30000;
const POPUP_FALLBACK_MS = 8000;
const POPUP_GAP_MS = 1200;
const POPUP_SHOW_DELAY_MS = 110;
const POPUP_EXIT_MS = 280;
const VOICE_LOAD_TIMEOUT_MS = 2000;

let knownDonationIds = new Set();
let initialized = false;
let donationQueue = [];
let isProcessingQueue = false;
let incentiveDescriptionCache = new Map();
let voicesReadyPromise = null;
let refreshInProgress = false;

const PROXY_BASE_URL = "https://extra-life-proxy.extra-life-proxy.workers.dev";
const MAX_KNOWN_DONATION_IDS = 2500;
const MAX_INCENTIVE_CACHE_SIZE = 200;
const MAX_DONATION_QUEUE_SIZE = 25;

const isLocalDev =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "::1" ||
    window.location.protocol === "file:";

function wait(ms) {

    return new Promise(resolve => {
        setTimeout(resolve, ms);
    });
}

function getPreferredVoice() {

    if (!("speechSynthesis" in window)) {
        return null;
    }

    const voices = window.speechSynthesis.getVoices();

    return voices.find(voice =>
        /zira/i.test(voice.name)
    ) || null;
}

function waitForVoices(timeoutMs = VOICE_LOAD_TIMEOUT_MS) {

    if (!("speechSynthesis" in window)) {
        return Promise.resolve([]);
    }

    const existingVoices = window.speechSynthesis.getVoices();

    if (existingVoices.length > 0) {
        return Promise.resolve(existingVoices);
    }

    if (voicesReadyPromise) {
        return voicesReadyPromise;
    }

    voicesReadyPromise = new Promise(resolve => {

        const complete = () => {

            window.speechSynthesis.removeEventListener("voiceschanged", onVoicesChanged);
            resolve(window.speechSynthesis.getVoices());
        };

        const onVoicesChanged = () => {
            complete();
        };

        window.speechSynthesis.addEventListener("voiceschanged", onVoicesChanged, { once: true });
        setTimeout(complete, timeoutMs);
    }).finally(() => {
        voicesReadyPromise = null;
    });

    return voicesReadyPromise;
}

async function getExtraLifeJson(path) {
    const response = await fetch(`${PROXY_BASE_URL}/api/${path}`);

    if (!response.ok) {
        throw new Error(`Request failed: ${response.status} ${response.statusText}`);
    }

    return response.json();
}

async function getIncentiveDescription(incentiveId) {

    if (!incentiveId) {
        return null;
    }

    if (incentiveDescriptionCache.has(incentiveId)) {
        return incentiveDescriptionCache.get(incentiveId);
    }

    if (incentiveDescriptionCache.size >= MAX_INCENTIVE_CACHE_SIZE) {
        const firstKey = incentiveDescriptionCache.keys().next().value;

        if (firstKey !== undefined) {
            incentiveDescriptionCache.delete(firstKey);
        }
    }

    try {

        const incentive = await getExtraLifeJson(
            `participants/${participantId}/incentives/${encodeURIComponent(incentiveId)}`
        );

        const description = (incentive.description || "").trim() || null;

        incentiveDescriptionCache.set(incentiveId, description);
        return description;

    } catch (err) {

        console.warn("Failed to load incentive description", incentiveId, err);
        incentiveDescriptionCache.set(incentiveId, null);
        return null;
    }
}

async function loadDonations() {

    const donations = await getExtraLifeJson(`participants/${participantId}/donations`);

    donations.sort((a, b) =>
        new Date(b.createdDateUTC) -
        new Date(a.createdDateUTC)
    );

    const tickerText = donations
        .slice(0, 20)
        .map(d =>
            `${d.displayName || "Anonymous"} $${Number(d.amount).toFixed(2)}`
        )
        .join(" • ");

    document.getElementById("ticker").textContent =
        `❤️ Recent Donors • ${tickerText}`;

    detectNewDonations(donations);
}

async function loadGoalProgress() {

    const participant = await getExtraLifeJson(`participants/${participantId}`);

    const raised = participant.sumDonations;
    const goal = participant.fundraisingGoal;

    const percent = Math.min(
        100,
        (raised / goal) * 100
    );

    document.getElementById("goalText").textContent =
        `$${Number(raised).toFixed(2).toLocaleString()} / $${Number(goal).toFixed(2).toLocaleString()} (${percent.toFixed(0)}%)`;

    document.getElementById("progressFill").style.width =
        `${percent}%`;
}

async function showDonationPopup(donation) {

    const incentiveId = donation.incentiveID || donation.incentiveId;
    const incentive = await getIncentiveDescription(incentiveId);

    if ("speechSynthesis" in window) {
        await waitForVoices();
    }

    return new Promise(resolve => {

        const overlay = document.getElementById("overlay");
        const popup = document.getElementById("donationPopup");
        const popupBody = document.getElementById("popupBody");
        const popupIncentive = document.getElementById("popupIncentive");
        const donorName = donation.displayName || "Anonymous";
        const primaryMessage = `${donorName} donated $${Number(donation.amount).toFixed(2)}`;
        const message = incentive
            ? `${primaryMessage} to ${incentive}`
            : primaryMessage;
        const donationMessage = (donation.message || donation.Message || "").trim();
        const spokenMessage = donationMessage
            ? `${message}. Message: ${donationMessage}`
            : message;
        let hasFinished = false;

        const finish = () => {

            if (hasFinished) {
                return;
            }

            hasFinished = true;
            popup.classList.remove("show");

            // Collapse the center lane after the card has eased out.
            setTimeout(() => {
                overlay.classList.remove("alert-open");
            }, POPUP_EXIT_MS);

            resolve();
        };

        popupBody.textContent =
            primaryMessage;

        popupIncentive.textContent = incentive
            ? `Incentive: ${incentive}`
            : "";

        overlay.classList.add("alert-open");

        // Start the card animation after the lane has begun opening.
        setTimeout(() => {
            popup.classList.add("show");
        }, POPUP_SHOW_DELAY_MS);

        if ("speechSynthesis" in window) {

            const utterance = new SpeechSynthesisUtterance(spokenMessage);
            const selectedVoice = getPreferredVoice();

            if (selectedVoice) {
                utterance.voice = selectedVoice;
                utterance.lang = selectedVoice.lang;
            }

            utterance.onend = finish;
            utterance.onerror = finish;

            window.speechSynthesis.speak(utterance);

            // Browser/overlay quirks can prevent speech callbacks; keep a fallback.
            setTimeout(finish, POPUP_FALLBACK_MS);
            return;
        }

        setTimeout(finish, POPUP_FALLBACK_MS);
    });
}

async function processDonationQueue() {

    if (isProcessingQueue) {
        return;
    }

    isProcessingQueue = true;

    while (donationQueue.length > 0) {

        const donation = donationQueue.shift();
        await showDonationPopup(donation);

        if (donationQueue.length > 0) {
            await wait(POPUP_GAP_MS);
        }
    }

    isProcessingQueue = false;
}

function enqueueDonationPopup(donation) {

    if (donationQueue.length >= MAX_DONATION_QUEUE_SIZE) {
        donationQueue.shift();
    }

    donationQueue.push(donation);
    processDonationQueue();
}

function detectNewDonations(donations) {

    if (!initialized) {

        donations.forEach(d =>
            knownDonationIds.add(d.donationID)
        );

        while (knownDonationIds.size > MAX_KNOWN_DONATION_IDS) {
            const oldestId = knownDonationIds.values().next().value;

            if (oldestId === undefined) {
                break;
            }

            knownDonationIds.delete(oldestId);
        }

        initialized = true;
        return;
    }

    donations.forEach(donation => {

        if (!knownDonationIds.has(donation.donationID)) {

            knownDonationIds.add(donation.donationID);

            while (knownDonationIds.size > MAX_KNOWN_DONATION_IDS) {
                const oldestId = knownDonationIds.values().next().value;

                if (oldestId === undefined) {
                    break;
                }

                knownDonationIds.delete(oldestId);
            }

            enqueueDonationPopup(donation);
        }
    });
}

async function refresh() {

    if (refreshInProgress) {
        return;
    }

    refreshInProgress = true;

    try {

        await Promise.all([
            loadDonations(),
            loadGoalProgress()
        ]);

    } catch (err) {

        console.error(err);
    } finally {
        refreshInProgress = false;
    }
}

const testDonationButton = document.getElementById("testDonation");
const testIncentivesButton = document.getElementById("testIncentives");

if (isLocalDev) {

    if (testDonationButton) {
        testDonationButton.hidden = false;

        testDonationButton.addEventListener("click", () => {

            enqueueDonationPopup({
                displayName: "Wyatt",
                amount: 25,
                message: "W",
                incentiveID: "952F1FE6-AA95-1704-AC5C4FBDA7B53445"
            });

            enqueueDonationPopup({
                displayName: "Hunter",
                amount: 1000,
                message: "This guys playing a dinosaur game lol"
            });

        });
    }

    if (testIncentivesButton) {
        testIncentivesButton.hidden = false;

        testIncentivesButton.addEventListener("click", async () => {

            try {

                const incentives = await getExtraLifeJson(`participants/${participantId}/incentives`);
                console.log("Incentives endpoint response:", incentives);
                console.table(incentives);

            } catch (err) {

                console.error("Failed to fetch incentives endpoint", err);
            }

        });
    }
}

if ("speechSynthesis" in window) {
    waitForVoices();
}

refresh();

setInterval(
    refresh,
    POLL_INTERVAL
);