# Anthem Predictive Engagement — Build Guide

Two distinct bot experiences (login failure, invalid Member ID) on a single
Messenger deployment, with a working Customer Journey panel for the agent.

---

## Phase 0 — Fix why your Customer Journey looks empty

Your tracking already works: your journey panel showed 28 min / 18 page views.
What is missing is **configuration**, not code. The green ticks and segment
chips in your colleague's journey panel come from Segments matching. You have
none, so the agent sees bare dots.

### 0.1 Confirm the allowed domain covers your test host

**Admin → Predictive Engagement → Settings → Allowed Domains**

You are testing on `localhost:63342`. Add `localhost` as an allowed domain, or
you will get intermittent tracking that is hard to distinguish from a code bug.
Better: put the site behind a real hostname (even a hosts-file alias like
`anthem.local`) so your dev environment matches production behaviour.

### 0.2 Verify events are arriving

**Admin → Predictive Engagement → Live Now**

Open your site in another tab, trigger a bad login twice, and watch Live Now.
You should see the pageview *and* a `login_failed` event. If the pageview shows
but the custom event does not, the problem is the event call, not the snippet.

The shared library logs every command result to the console when
`GXE.DEBUG = true`. A `REJECTED` line tells you exactly which command failed.

### 0.3 Create Segments — this is the actual fix

**Admin → Predictive Engagement → Segments → Create Segment**

| Segment name | Type | Match criteria |
|---|---|---|
| `Login Friction` | Session | Custom event `login_failed` occurred |
| `Find Care ID Friction` | Session | Custom event `member_id_invalid` occurred |
| `Find Care Browsers` | Session | Page URL contains `find-care` |
| `Authenticated Attempt` | Session | Page URL contains `member-account` |

Once these exist, the agent's Customer Journey panel starts showing segment
chips instead of "No segments matched", and the timeline dots gain markers.

### 0.4 Create Outcomes (optional but recommended)

**Admin → Predictive Engagement → Outcomes**

| Outcome | Achieved when |
|---|---|
| `Successful Login` | Custom event `login_succeeded` |
| `Provider Search Started` | Custom event `member_id_validated` |

Note: Genesys has announced deprecation of the Journey Outcomes feature, so do
not build anything load-bearing on outcome scoring. Segments are the durable
choice.

---

## Phase 1 — Decide who owns the invite

You currently have a hand-rolled banner **and** (once you build Action Maps) a
native Genesys invite. Both will fire on the same event and the visitor sees
two competing prompts.

Set `GXE.BANNER_MODE` in `genesys-engagement.js`:

- **`"local"`** — your banner is the invite. Build the Action Maps with an
  action type that is *not* Web Messaging (or skip them and rely on Segments
  for journey visibility only).
- **`"native"`** — Genesys's invite is the invite. Your banner is suppressed.
  Requires Action Maps with the Web Messaging action.

For a demo, `"local"` gives you deterministic, instant behaviour. For a
production-realistic build, `"native"` is the correct architecture because
frequency capping, schedule groups and agent availability are all respected.

---

## Phase 2 — Action Maps (only if BANNER_MODE = "native")

**Admin → Predictive Engagement → Action Maps → Create action map**

### Map A: Login assistance
- Trigger: **Visitor activity → Custom web event → `login_failed`**
- Condition: `attemptCount` greater than or equal to `2`
- Action: **Web Messaging**
- Schedule group: your support queue's hours
- Priority: `5`
- Page URL condition: contains `member-account`

### Map B: Find Care ID assistance
- Trigger: **Visitor activity → Custom web event → `member_id_invalid`**
- Condition: `attemptCount` greater than or equal to `2`
- Action: **Web Messaging**
- Priority: `5`
- Page URL condition: contains `find-care`

Two things that will bite you here:

1. **One action map per action type, per page, per session.** If both maps
   somehow qualify on the same page, only one offers. Keep the URL conditions
   tight so they can't overlap.
2. **An action map qualifies only once per session.** During testing you will
   trigger it, then wonder why it never fires again. Use a fresh incognito
   window, or clear the Genesys cookies, between test runs.

---

## Phase 3 — Pass page context into the conversation

This is what makes one deployment serve two different bots.

The browser already does this via the shared library:

```js
Genesys("command", "Database.set", {
  messaging: {
    customAttributes: {
      "context.pageSource":     "find-care",
      "context.contactReason":  "invalid_member_id",
      "context.memberIdEntered":"YWX99",
      "context.accountType":    "medicare",
      "context.attemptCount":   "2"
    }
  }
});
```

Constraints worth knowing before you design around this:

- The whole `customAttributes` object is capped at **2048 bytes**. Exceeding it
  raises `MessagingService.customAttributesSizeExceeded`.
- Individual attribute values cap at **500 characters**.
- Null, undefined and empty-string values are silently dropped.
- Set this **before** the visitor opens the messenger, which is what
  `GXE.offerAssistance()` does.

Never put credentials, full member IDs in production, PHI, or anything you
wouldn't want in the conversation record into these attributes. What the member
typed into a public form is defensible; their password is not.

---

## Phase 4 — Eligibility Data Action

**Admin → Integrations → Actions → Add Action → Web Services Data Actions**

First create the integration itself (**Admin → Integrations → Integrations →
Web Services Data Actions**) and set credentials there, not in the action.

### Contract — Input

```json
{
  "type": "object",
  "properties": {
    "memberId":    { "type": "string" },
    "accountType": { "type": "string" }
  },
  "required": ["memberId"]
}
```

### Contract — Output

```json
{
  "type": "object",
  "properties": {
    "valid":     { "type": "boolean" },
    "planName":  { "type": "string" },
    "network":   { "type": "string" },
    "prefix":    { "type": "string" },
    "reason":    { "type": "string" }
  }
}
```

### Request configuration

- Request URL Template: `/eligibility/v1/member/lookup`
- Method: `POST`
- Body template:

```
{
  "memberId": "${input.memberId}",
  "accountType": "${input.accountType}"
}
```

- Response translation map:

```
{
  "valid":    $.eligible,
  "planName": $.plan.displayName,
  "network":  $.plan.network,
  "prefix":   $.plan.prefix,
  "reason":   $.failureReason
}
```

Test the action in the Genesys UI before wiring it into a flow. A data action
that fails in the test panel will fail silently-ish in a bot flow and you'll
spend an afternoon blaming Architect.

---

## Phase 5 — Architect flows

### 5.1 Structure

```
Inbound Message Flow: "Anthem_Web_Router"       <- bound to the deployment
   |
   +-- Get Participant Data
   |      context.pageSource     -> flowVar.pageSource
   |      context.contactReason  -> flowVar.contactReason
   |      context.memberIdEntered-> flowVar.memberId
   |      context.accountType    -> flowVar.accountType
   |      context.attemptCount   -> flowVar.attemptCount
   |
   +-- Decision / Switch on flowVar.contactReason
          |
          +-- "invalid_member_id" -> Call Bot Flow "Bot_FindCare_MemberID"
          +-- "login_failure"     -> Call Bot Flow "Bot_Login_Support"
          +-- default             -> Call Bot Flow "Bot_General_Support"
```

One router, three bots. Adding a third friction point later means adding one
branch, not another deployment.

### 5.2 Get Participant Data specifics

The attribute name in the Get Participant Data action must match exactly,
**including the `context.` prefix and the case**:

| Attribute Name | Variable |
|---|---|
| `context.pageSource` | `Flow.pageSource` |
| `context.contactReason` | `Flow.contactReason` |
| `context.memberIdEntered` | `Flow.memberIdEntered` |
| `context.accountType` | `Flow.accountType` |
| `context.attemptCount` | `Flow.attemptCount` |

Attribute names are case-sensitive and there is no warning if you get it wrong
— you just get an empty string. When a branch mysteriously always falls to
default, this is the first thing to check.

Also note: participant data is stored as a semi-structured text blob, suited to
runtime routing logic. Don't treat it as your analytics layer; that's what
Journey events and conversation attribute schemas are for.

### 5.3 Bot_FindCare_MemberID design

```
Start
 |
 +-- [Flow.memberIdEntered is not blank?]
 |        yes -> "I see you tried <ID>. Let me check that for you."
 |               -> goto VALIDATE
 |        no  -> Ask Slot: memberId (type: String)
 |               -> goto VALIDATE
 |
VALIDATE:
 +-- Call Data Action: Eligibility_MemberLookup
 |        memberId    = Slot.memberId (or Flow.memberIdEntered)
 |        accountType = Flow.accountType
 |
 +-- [Success path]
 |     +-- valid == true
 |     |     -> "Great — that's your <planName> plan on the <network> network."
 |     |     -> Set Participant Data: resolutionType = "self_served"
 |     |     -> Communicate link to provider search
 |     |     -> Exit Bot (reason: "resolved")
 |     |
 |     +-- valid == false, retryCount < 2
 |     |     -> "That doesn't match our records. The prefix is the first three
 |     |         characters on the front of your card."
 |     |     -> Clear slot, increment retryCount, loop to Ask Slot
 |     |
 |     +-- valid == false, retryCount >= 2
 |           -> Set Participant Data: escalationReason = "id_lookup_failed"
 |           -> "Let me get someone to help you look this up."
 |           -> Exit Bot (reason: "escalate")
 |
 +-- [Failure / Timeout path]
       -> Set Participant Data: escalationReason = "eligibility_api_down"
       -> Exit Bot (reason: "escalate")
```

Bot flow limits to design within: **50 Set Participant Data executions** and
**50 attributes** per bot session, 500 chars per value. The retry loop above
must not set participant data on every iteration or you will hit that ceiling
in a long session.

Handle the data action Failure path explicitly. If your eligibility API is
down and you only built the Success path, the bot dead-ends and the member
gets nothing.

### 5.4 Back in the router, after the bot returns

```
+-- Bot exit reason
      +-- "resolved"  -> Disconnect
      +-- "escalate"  -> Set Participant Data (summary for the agent)
                      -> Transfer to ACD: Queue "Anthem_Member_Support"
```

Set a short, human-readable summary attribute before transferring. The agent
sees participant data next to the Customer Journey panel; giving them
"Tried member ID YWX99 twice, prefix not recognised" saves the first 30
seconds of every escalated conversation.

---

## Phase 6 — Test matrix

| Scenario | Expected |
|---|---|
| Load find-care.html | Live Now shows pageview `/Anthem/find-care.html` |
| Enter `ZZZ123`, submit once | Inline error; `member_id_invalid` in Live Now; **no banner** |
| Submit a second time | Banner appears; `Find Care ID Friction` segment matches |
| Click banner, chat opens | Bot greets with the ID you typed, not a generic hello |
| Enter `YWX999999` in bot | Bot returns plan name, exits resolved |
| Fail twice in bot | Transfers to queue with escalation reason set |
| Bad login twice | Different bot greeting than the Find Care path |
| Agent opens Customer Journey | Segment chips visible, both pages in the timeline |

The critical assertion is row 4 and row 7 together: same deployment, same
launcher, two demonstrably different conversations. That's the thing to show
your stakeholders.

---

## Known issues in the code you sent me

1. **`Journey.pageview` gated on `Launcher.ready`** on all five pages. The
   Journey plugin is a separate plugin with its own ready event; Genesys docs
   are explicit that you subscribe to `Journey.ready` before any Journey
   command. It happens to work in your org today, which is worse than failing
   — it's a race you'll lose on a slow connection.

2. **`find-care.html` had no JavaScript at all.** The Continue button was a
   bare submit that reloaded the page. There was no validation to hook
   engagement onto, which is the real reason "the same bot" appeared — nothing
   page-specific ever ran.

3. **`newlogin.txt` and `newaccountlogin.txt` are near-duplicate pages** with
   different default selections (`selectedCategory = ''` vs `'members'`) and
   different fallback behaviour. Both report the same `page` value to Journey.
   Pick one and delete the other; duplicate pages reporting identical
   pageviews will make your journey analysis untrustworthy.

4. **Banner and Action Map would both fire.** Addressed by `GXE.BANNER_MODE`.

5. **Offer fired on the very first failure.** One typo is not friction. Firing
   immediately also consumes the session's single action-map qualification on
   what is usually a self-correcting mistake.

6. **`Journey.record` fired inside `typeof Genesys !== 'undefined'`.** The
   global exists as soon as the bootstrap snippet runs, long before the Journey
   plugin is ready, so this guard gave false confidence.
