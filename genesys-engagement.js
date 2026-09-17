/* ==========================================================================
   genesys-engagement.js  (v2)
   Shared Genesys Journey + Predictive Engagement library for the Anthem site.

   WHY THIS FILE EXISTS
   --------------------
   All pages share ONE Messenger deployment, because a Genesys Cloud Messenger
   deployment is bound to exactly one Inbound Message flow. Different bot
   experiences per page are therefore achieved by pushing PAGE CONTEXT into
   the conversation as custom attributes (Database.set) and branching inside
   that single Architect Inbound Message flow — NOT by using a second
   deployment. Using a second deployment would split the visitor session and
   fragment the Customer Journey panel the agent sees.

   USAGE — on every page, before this script:

     <script>
       window.GENESYS_CONTEXT = {
         page:      "/Anthem/find-care.html",
         pageTitle: "Find Care",
         pageSource:"find-care"            // <- Architect branches on this
       };
     </script>
     <script src="genesys-engagement.js"></script>

   PUBLIC API
   ----------
   GXE.trackEvent(name, attrs)
        Fire a Journey custom event (drives Segments + Action Maps).

   GXE.setConversationContext(attrs)
        Push custom attributes onto the NEXT/current conversation so the
        Architect flow can read them with Get Participant Data.
        Keys are prefixed "context." — that is the convention Architect's
        Get Participant Data expects for Messenger custom attributes.

   GXE.offerAssistance({ eventName, journeyAttrs, contextAttrs, message })
        The friction-moment helper. Does all four things in the right order:
          1. Journey.record  -> Predictive Engagement / Segments / Action Maps
          2. Database.set    -> context for the Architect flow
          3. Launcher.show   -> make sure the button is reachable
          4. local banner    -> instant visual cue (see BANNER NOTE below)

   BANNER NOTE
   -----------
   The local banner is deliberately NOT a substitute for a Predictive
   Engagement invite. Pick one of these and stick to it, or the visitor sees
   two competing invites:
     - GXE.BANNER_MODE = "local"  : our banner is the invite. Do NOT set the
                                    Action Map action to Web Messaging; use
                                    the Action Map for segments/reporting only.
     - GXE.BANNER_MODE = "native" : Genesys's own invite is the invite. Our
                                    banner is suppressed and we rely on the
                                    Action Map. Slight delay while it qualifies.
   ========================================================================== */

window.GXE = (function () {

  var CONFIG = window.GENESYS_CONTEXT || {};
  var api = {};

  api.BANNER_MODE = "local";   // "local" | "native"
  api.DEBUG = true;            // set false in production

  function log() {
    if (!api.DEBUG) return;
    var args = Array.prototype.slice.call(arguments);
    console.log.apply(console, ["[GXE]"].concat(args));
  }

  /* ---------- readiness helpers -------------------------------------- */

  function whenGenesysLoaded(cb, attempt) {
    attempt = attempt || 0;
    if (typeof Genesys === "function") { cb(); return; }
    if (attempt > 40) { log("Genesys global never appeared - check the bootstrap snippet / CSP"); return; }
    setTimeout(function () { whenGenesysLoaded(cb, attempt + 1); }, 250);
  }

  // Journey commands must be gated on Journey.ready, NOT Launcher.ready.
  // Launcher.ready only means the chat BUTTON is ready; the Journey plugin
  // is a separate plugin with its own lifecycle. Gating on Launcher.ready
  // is a race condition that silently drops Journey commands.
  function onJourneyReady(cb) {
    whenGenesysLoaded(function () {
      Genesys("subscribe", "Journey.ready", cb);
    });
  }

  function onDatabaseReady(cb) {
    whenGenesysLoaded(function () {
      Genesys("subscribe", "Database.ready", cb);
    });
  }

  /* ---------- 1. pageview --------------------------------------------- */

  onJourneyReady(function () {
    var payload = {
      page: CONFIG.page || window.location.pathname,
      pageTitle: CONFIG.pageTitle || document.title
    };
    Genesys("command", "Journey.pageview", payload,
      function () { log("pageview recorded", payload); },
      function (e) { log("pageview REJECTED", e); }
    );
  });

  /* ---------- 2. custom journey events -------------------------------- */

  api.trackEvent = function (eventName, attrs) {
    onJourneyReady(function () {
      var payload = { eventName: eventName };
      if (attrs && Object.keys(attrs).length) payload.customAttributes = attrs;
      Genesys("command", "Journey.record", payload,
        function () { log("event recorded:", eventName, attrs); },
        function (e) { log("event REJECTED:", eventName, e); }
      );
    });
  };

  /* ---------- 3. conversation context for Architect -------------------- */

  api.setConversationContext = function (attrs) {
    if (!attrs) return;
    var custom = {};
    Object.keys(attrs).forEach(function (k) {
      var v = attrs[k];
      if (v === null || v === undefined || v === "") return;   // dropped by Genesys anyway
      custom["context." + k] = String(v).substring(0, 500);    // 500 char attribute cap
    });

    onDatabaseReady(function () {
      Genesys("command", "Database.set", {
        messaging: { customAttributes: custom }
      },
        function () { log("context set", custom); },
        function (e) { log("Database.set REJECTED", e); }
      );
    });
  };

  /* ---------- 4. the friction-moment helper --------------------------- */

  api.offerAssistance = function (opts) {
    opts = opts || {};

    // (a) tell Predictive Engagement — this is what Segments and Action Maps see
    api.trackEvent(opts.eventName, opts.journeyAttrs);

    // (b) tell the Architect flow which experience to serve
    var ctx = opts.contextAttrs || {};
    ctx.pageSource = ctx.pageSource || CONFIG.pageSource || "unknown";
    ctx.contactReason = ctx.contactReason || opts.eventName;
    api.setConversationContext(ctx);

    // (c) make the launcher reachable
    whenGenesysLoaded(function () {
      Genesys("command", "Launcher.show");
    });

    // (d) instant visual cue — only in "local" mode
    if (api.BANNER_MODE === "local") {
      showBanner(opts.message || "Hi there, do you need any help?");
    }
  };

  /* ---------- banner -------------------------------------------------- */

  function showBanner(messageText) {
    if (document.getElementById("gxe-offer-banner")) return;

    var wrap = document.createElement("div");
    wrap.id = "gxe-offer-banner";
    wrap.setAttribute("role", "status");
    wrap.style.cssText = [
      "position:fixed", "bottom:95px", "right:20px", "background:#ffffff",
      "border:1px solid #cbd5e1", "border-radius:8px", "padding:12px 16px",
      "box-shadow:0 8px 20px rgba(0,0,0,0.25)", "z-index:2147483000",
      "display:flex", "align-items:center", "gap:12px", "max-width:280px",
      "font:500 14px -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif",
      "color:#1e293b"
    ].join(";");

    var msg = document.createElement("span");
    msg.textContent = messageText;
    msg.style.cssText = "cursor:pointer;flex:1;";
    msg.addEventListener("click", function () {
      api.trackEvent("offer_banner_accepted", { source: CONFIG.pageSource || "unknown" });
      removeBanner();
      whenGenesysLoaded(function () { Genesys("command", "Messenger.open"); });
    });

    var close = document.createElement("button");
    close.setAttribute("aria-label", "Dismiss");
    close.textContent = "\u00D7";
    close.style.cssText = "background:none;border:none;font-size:18px;color:#64748b;cursor:pointer;padding:0 4px;line-height:1;";
    close.addEventListener("click", function () {
      api.trackEvent("offer_banner_dismissed", { source: CONFIG.pageSource || "unknown" });
      removeBanner();
    });

    wrap.appendChild(msg);
    wrap.appendChild(close);
    document.body.appendChild(wrap);

    api.trackEvent("offer_banner_shown", { source: CONFIG.pageSource || "unknown" });
  }

  function removeBanner() {
    var b = document.getElementById("gxe-offer-banner");
    if (b) b.remove();
  }

  api.dismissBanner = removeBanner;

  /* ---------- native-invite mode plumbing ------------------------------ */
  // In "native" mode Genesys publishes an offer we can observe (useful for
  // debugging whether your Action Map actually qualified).
  whenGenesysLoaded(function () {
    Genesys("subscribe", "Journey.qualifiedWebMessagingOffer", function (e) {
      log("Action Map qualified a web messaging offer", e && e.data);
    });
  });

  return api;
})();
