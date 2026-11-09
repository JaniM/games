import { Fragment, type ReactNode } from "react";
import { Link } from "../Link";
import { OPERATOR, type Operator } from "../site";

export interface PrivacyProps {
  /** Who runs the site. */
  operator?: Operator;
}

/** When the text below last changed. Change it with the text. */
const UPDATED = "November 9, 2026";

/** The numbered sections, in order: the table of contents and the headings both come from here. */
const SECTIONS = [
  { id: "information", title: "What information do we collect?" },
  { id: "processing", title: "How do we process your information?" },
  {
    id: "legal-bases",
    title: "What legal bases do we rely on to process your personal information?",
  },
  { id: "sharing", title: "When and with whom do we share your personal information?" },
  { id: "retention", title: "How long do we keep your information?" },
  { id: "security", title: "How do we keep your information safe?" },
  { id: "rights", title: "What are your privacy rights?" },
  { id: "do-not-track", title: "Controls for Do-Not-Track features" },
  { id: "us-rights", title: "Do United States residents have specific privacy rights?" },
  { id: "updates", title: "Do we make updates to this notice?" },
  { id: "contact", title: "How can you contact us about this notice?" },
  {
    id: "review",
    title: "How can you review, update, or delete the data we collect from you?",
  },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];
/** Where a link on this page can go: a section, or one of the two other places that are linked to. */
type Anchor = SectionId | "contents" | "withdrawing-consent";

const HEADINGS = Object.fromEntries(
  SECTIONS.map(({ id, title }, index) => [id, `${index + 1}. ${title}`]),
) as Record<SectionId, string>;

/**
 * A link to somewhere else on this page. Not a `Link`: the browser scrolls to the anchor by
 * itself, and the router only reads the path, which stays the same.
 */
function To({ id, children }: { id: Anchor; children: ReactNode }) {
  return <a href={`#${id}`}>{children}</a>;
}

function Heading({ id }: { id: SectionId }) {
  return <h2 id={id}>{HEADINGS[id]}</h2>;
}

function InShort({ children }: { children: ReactNode }) {
  return (
    <p>
      <strong>In short:</strong> {children}
    </p>
  );
}

/**
 * The categories of personal information that US state laws ask about. `collected` is whether
 * the site keeps something in the category, and what, is in the first section: identifiers are
 * the username, the user id, the access tokens and the IP address in a host's logs; network
 * activity is the games a user plays and their moves.
 */
const CATEGORIES: { name: string; examples: string; collected: boolean }[] = [
  {
    name: "A. Identifiers",
    examples:
      "Contact details, such as real name, alias, postal address, telephone or mobile contact number, unique personal identifier, online identifier, Internet Protocol address, email address, and account name",
    collected: true,
  },
  {
    name: "B. Personal information as defined in the California Customer Records statute",
    examples: "Name, contact information, education, employment, employment history, and financial information",
    collected: false,
  },
  {
    name: "C. Protected classification characteristics under state or federal law",
    examples: "Gender, age, date of birth, race and ethnicity, national origin, marital status, and other demographic data",
    collected: false,
  },
  {
    name: "D. Commercial information",
    examples: "Transaction information, purchase history, financial details, and payment information",
    collected: false,
  },
  { name: "E. Biometric information", examples: "Fingerprints and voiceprints", collected: false },
  {
    name: "F. Internet or other similar network activity",
    examples:
      "Browsing history, search history, online behavior, interest data, and interactions with our and other websites, applications, systems, and advertisements",
    collected: true,
  },
  { name: "G. Geolocation data", examples: "Device location", collected: false },
  {
    name: "H. Audio, electronic, sensory, or similar information",
    examples: "Images and audio, video or call recordings created in connection with our business activities",
    collected: false,
  },
  {
    name: "I. Professional or employment-related information",
    examples:
      "Business contact details in order to provide you our Services at a business level or job title, work history, and professional qualifications if you apply for a job with us",
    collected: false,
  },
  {
    name: "J. Education Information",
    examples: "Student records and directory information",
    collected: false,
  },
  {
    name: "K. Inferences drawn from collected personal information",
    examples:
      "Inferences drawn from any of the collected personal information listed above to create a profile or summary about, for example, an individual’s preferences and characteristics",
    collected: false,
  },
  { name: "L. Sensitive personal information", examples: "", collected: false },
];

/**
 * The privacy policy: a standard privacy notice, with what this site does written into it. When
 * the code changes what it stores or who sees it, this page changes with it: the backend's
 * migrations (`backend/migrations`) and the browser storage keys (`features/session/credentials.ts`,
 * `features/sound/storage.ts`, `features/lobby/storage.ts`) are what it describes, and what
 * deleting a user does is `remove_user` in `backend/src/account.rs`.
 */
export function Privacy({ operator = OPERATOR }: PrivacyProps) {
  const mail = <a href={`mailto:${operator.email}`}>{operator.email}</a>;
  return (
    <main className="page prose">
      <header className="page-header">
        <h1>Privacy policy</h1>
        <p>{`Last updated ${UPDATED}`}</p>
      </header>

      <p>
        This Privacy Notice for {operator.name} (“we,” “us,” or “our”), describes how and why we
        might access, collect, store, use, and/or share (“process”) your personal information when
        you use our services (“Services”), including when you:
      </p>
      <ul>
        <li>
          Visit our website at {operator.url} or any website of ours that links to this Privacy
          Notice
        </li>
        <li>Engage with us in other related ways, including any marketing or events</li>
      </ul>
      <p>
        <strong>Questions or concerns?</strong> Reading this Privacy Notice will help you
        understand your privacy rights and choices. We are responsible for making decisions about
        how your personal information is processed. If you do not agree with our policies and
        practices, please do not use our Services. If you still have any questions or concerns,
        please contact us at {mail}.
      </p>

      <h2>Summary of key points</h2>
      <p>
        This summary provides key points from our Privacy Notice, but you can find out more details
        about any of these topics by clicking the link following each key point or by using our{" "}
        <To id="contents">table of contents</To> below to find the section you are looking for.
      </p>
      <p>
        <strong>What personal information do we process?</strong> When you visit, use, or navigate
        our Services, we may process personal information depending on how you interact with us and
        the Services, the choices you make, and the products and features you use. Learn more about{" "}
        <To id="information">personal information you disclose to us</To>.
      </p>
      <p>
        <strong>Do we process any sensitive personal information?</strong> Some of the information
        may be considered “special” or “sensitive” in certain jurisdictions, for example your racial
        or ethnic origins, sexual orientation, and religious beliefs. We do not process sensitive
        personal information.
      </p>
      <p>
        <strong>Do we collect any information from third parties?</strong> We do not collect any
        information from third parties.
      </p>
      <p>
        <strong>How do we process your information?</strong> We process your information to
        provide, improve, and administer our Services, communicate with you, for security and fraud
        prevention, and to comply with law. We may also process your information for other purposes
        with your consent. We process your information only when we have a valid legal reason to do
        so. Learn more about <To id="processing">how we process your information</To>.
      </p>
      <p>
        <strong>In what situations and with which parties do we share personal information?</strong>{" "}
        We may share information in specific situations and with specific third parties. Learn more
        about <To id="sharing">when and with whom we share your personal information</To>.
      </p>
      <p>
        <strong>How do we keep your information safe?</strong> We have adequate organizational and
        technical processes and procedures in place to protect your personal information. However,
        no electronic transmission over the internet or information storage technology can be
        guaranteed to be 100% secure, so we cannot promise or guarantee that hackers,
        cybercriminals, or other unauthorized third parties will not be able to defeat our security
        and improperly collect, access, steal, or modify your information. Learn more about{" "}
        <To id="security">how we keep your information safe</To>.
      </p>
      <p>
        <strong>What are your rights?</strong> Depending on where you are located geographically,
        the applicable privacy law may mean you have certain rights regarding your personal
        information. Learn more about <To id="rights">your privacy rights</To>.
      </p>
      <p>
        <strong>How do you exercise your rights?</strong> The easiest way to exercise your rights
        is by writing to {mail}, or by contacting us. You can also delete your user yourself, from
        the account menu. We will consider and act upon any request in accordance with applicable
        data protection laws.
      </p>
      <p>
        <strong>
          Want to learn more about what we do with any information we collect?
        </strong>{" "}
        Review the Privacy Notice in full, starting with the <To id="contents">table of contents</To>.
      </p>

      <h2 id="contents">Table of contents</h2>
      <ol>
        {SECTIONS.map(({ id, title }) => (
          <li key={id}>
            <To id={id}>{title}</To>
          </li>
        ))}
      </ol>

      <Heading id="information" />
      <h3>Personal information you disclose to us</h3>
      <InShort>We collect personal information that you provide to us.</InShort>
      <p>
        We collect personal information that you voluntarily provide to us when you register on the
        Services, express an interest in obtaining information about us or our products and
        Services, when you participate in activities on the Services, or otherwise when you contact
        us.
      </p>
      <p>
        <strong>Personal Information Provided by You.</strong> The personal information that we
        collect depends on the context of your interactions with us and the Services, the choices
        you make, and the products and features you use. The personal information we collect may
        include the following:
      </p>
      <ul>
        <li>usernames</li>
        <li>passwords</li>
        <li>display names</li>
      </ul>
      <p>
        <strong>Sensitive Information.</strong> We do not process sensitive information.
      </p>

      <h3>Guests and accounts</h3>
      <p>
        You can use the site without an account. The first time you open it, it creates an
        anonymous user for your browser, a guest: a random id and a secret access token. Your
        browser keeps them and sends the token with each request to show that it is you.
      </p>
      <p>
        To get to your games from another device, you can make an account from the menu in the top
        right corner. It needs a username and a password, and no email address. Your guest becomes
        the account, so your games stay with you, and the guest’s access token is deleted. There is
        no email to send a link to, so a lost password can’t be reset.
      </p>
      <p>
        Your username is your name in games. Nobody else can have it, whatever its case, and you
        can’t change it later. It replaces the display name you had as a guest. A guest’s name is
        only what they typed, so other players see it with “(guest)” after it.
      </p>
      <p>
        Signing in gives that browser a session: an access token of its own. A session that has not
        been used for 30 days stops working, and signing out ends it at once.
      </p>

      <h3>What the Services keep</h3>
      <p>On the server:</p>
      <ul>
        <li>your user id, and when it was made;</li>
        <li>your access token, if you are a guest;</li>
        <li>
          if you have an account: your username, your password as a hash that can’t be turned back
          into the password, and for each session a hash of its token, when it was made and when it
          was last used;
        </li>
        <li>
          your display name, if you are a guest and pick one (up to 32 characters). If you have an
          account, your username is your name;
        </li>
        <li>
          every game you are in: who sat where, the game’s state, whether it is public, and when the
          game was made and last changed.
        </li>
      </ul>
      <p>A game against the bot is kept the same way.</p>
      <p>
        In your browser, in its local storage: your user id and access token, and your username if
        you have an account (<code>games.session</code>); the sound volume (
        <code>games.volume</code>); and whether new games are public (<code>games.public</code>).
      </p>
      <p>
        Whoever hosts the site may keep ordinary access logs of their own, such as the time of a
        request and the IP address it came from.
      </p>

      <Heading id="processing" />
      <InShort>
        We process your information to provide, improve, and administer our Services, communicate
        with you, for security and fraud prevention, and to comply with law. We process the personal
        information for the following purposes listed below. We may also process your information
        for other purposes only with your prior explicit consent.
      </InShort>
      <p>
        We process your personal information for a variety of reasons, depending on how you
        interact with our Services, including:
      </p>
      <ul>
        <li>
          <strong>
            To facilitate account creation and authentication and otherwise manage user accounts.
          </strong>{" "}
          We may process your information so you can create and log in to your account, as well as
          keep your account in working order.
        </li>
        <li>
          <strong>To deliver and facilitate delivery of services to the user.</strong> We may
          process your information to provide you with the requested service.
        </li>
        <li>
          <strong>To enable user-to-user communications.</strong> We may process your information
          if you choose to use any of our offerings that allow for communication with another user.
        </li>
        <li>
          <strong>To save or protect an individual’s vital interest.</strong> We may process your
          information when necessary to save or protect an individual’s vital interest, such as to
          prevent harm.
        </li>
      </ul>

      <Heading id="legal-bases" />
      <InShort>
        We only process your personal information when we believe it is necessary and we have a
        valid legal reason (i.e., legal basis) to do so under applicable law, like with your
        consent, to comply with laws, to provide you with services to enter into or fulfill our
        contractual obligations, to protect your rights, or to fulfill our legitimate business
        interests.
      </InShort>
      <p>
        <strong>If you are located in the EU or UK, this section applies to you.</strong>
      </p>
      <p>
        The General Data Protection Regulation (GDPR) and UK GDPR require us to explain the valid
        legal bases we rely on in order to process your personal information. As such, we may rely
        on the following legal bases to process your personal information:
      </p>
      <ul>
        <li>
          <strong>Consent.</strong> We may process your information if you have given us permission
          (i.e., consent) to use your personal information for a specific purpose. You can withdraw
          your consent at any time. Learn more about{" "}
          <To id="withdrawing-consent">withdrawing your consent</To>.
        </li>
        <li>
          <strong>Performance of a Contract.</strong> We may process your personal information when
          we believe it is necessary to fulfill our contractual obligations to you, including
          providing our Services or at your request prior to entering into a contract with you.
        </li>
        <li>
          <strong>Legal Obligations.</strong> We may process your information where we believe it
          is necessary for compliance with our legal obligations, such as to cooperate with a law
          enforcement body or regulatory agency, exercise or defend our legal rights, or disclose
          your information as evidence in litigation in which we are involved.
        </li>
        <li>
          <strong>Vital Interests.</strong> We may process your information where we believe it is
          necessary to protect your vital interests or the vital interests of a third party, such as
          situations involving potential threats to the safety of any person.
        </li>
      </ul>
      <p>
        <strong>If you are located in Canada, this section applies to you.</strong>
      </p>
      <p>
        We may process your information if you have given us specific permission (i.e., express
        consent) to use your personal information for a specific purpose, or in situations where
        your permission can be inferred (i.e., implied consent). You can withdraw your consent at
        any time.
      </p>
      <p>
        In some exceptional cases, we may be legally permitted under applicable law to process your
        information without your consent, including, for example:
      </p>
      <ul>
        <li>
          If collection is clearly in the interests of an individual and consent cannot be obtained
          in a timely way
        </li>
        <li>For investigations and fraud detection and prevention</li>
        <li>For business transactions provided certain conditions are met</li>
        <li>
          If it is contained in a witness statement and the collection is necessary to assess,
          process, or settle an insurance claim
        </li>
        <li>
          For identifying injured, ill, or deceased persons and communicating with next of kin
        </li>
        <li>
          If we have reasonable grounds to believe an individual has been, is, or may be victim of
          financial abuse
        </li>
        <li>
          If it is reasonable to expect collection and use with consent would compromise the
          availability or the accuracy of the information and the collection is reasonable for
          purposes related to investigating a breach of an agreement or a contravention of the laws
          of Canada or a province
        </li>
        <li>
          If disclosure is required to comply with a subpoena, warrant, court order, or rules of the
          court relating to the production of records
        </li>
        <li>
          If it was produced by an individual in the course of their employment, business, or
          profession and the collection is consistent with the purposes for which the information
          was produced
        </li>
        <li>
          If the collection is solely for journalistic, artistic, or literary purposes
        </li>
        <li>If the information is publicly available and is specified by the regulations</li>
        <li>
          We may disclose de-identified information for approved research or statistics projects,
          subject to ethics oversight and confidentiality commitments
        </li>
      </ul>

      <Heading id="sharing" />
      <InShort>
        We may share information in specific situations described in this section and/or with the
        following third parties.
      </InShort>
      <p>We may need to share your personal information in the following situations:</p>
      <ul>
        <li>
          <strong>Business Transfers.</strong> We may share or transfer your information in
          connection with, or during negotiations of, any merger, sale of company assets, financing,
          or acquisition of all or a portion of our business to another company.
        </li>
        <li>
          <strong>Other Users.</strong> When you share personal information or otherwise interact
          with public areas of the Services, such personal information may be viewed by all users
          and may be publicly made available outside the Services in perpetuity. Similarly, other
          users will be able to view descriptions of your activity, such as your name and your moves
          in a game you share with them. Who can see what is set out below.
        </li>
      </ul>

      <h3>Who can see what</h3>
      <ul>
        <li>
          <strong>Anyone, with no link and no account,</strong> can see the public games at{" "}
          <Link to="/games">/games</Link>. A game is public if the player who made it left “Public
          game” ticked in the dialog for a new game, which it is until they untick it, and the
          site remembers the choice in that browser. A public game is listed once both players are
          in it, with the players’ names, whether it is in progress or over, and when it last
          changed, and anyone can open it and watch every move. A rematch of a public game is
          public. Games still waiting for an opponent, and games made before the list existed, are
          not in it. The choice is made when the game is made and can’t be changed afterwards. To
          take a game out of the list, write to {mail} with its link.
        </li>
        <li>
          <strong>Your opponent, and anyone who has the link to a game,</strong> can see your
          display name (or “Player 1” and “Player 2” if you have none) and every move in that game.
          Anyone with the link can watch, so share it only with people you are happy to have watch.
        </li>
        <li>
          If you have an account, your username is shown as your name. A guest’s name is shown with
          “(guest)” after it, so that it can’t pass for an account’s.
        </li>
        <li>
          The game also sends your anonymous user id to everyone connected to it. It is not shown on
          the page, and it is not your name.
        </li>
        <li>
          A game can only be opened by someone who has its link. The public list is where the links
          of public games are.
        </li>
        <li>{operator.name}, which runs the site, can read everything the server keeps.</li>
      </ul>
      <p>
        Pick a display name you are happy to have strangers read: it is not checked or kept
        private.
      </p>

      <Heading id="retention" />
      <InShort>
        We keep your information for as long as necessary to fulfill the purposes outlined in this
        Privacy Notice unless otherwise required by law.
      </InShort>
      <p>
        We will only keep your personal information for as long as it is necessary for the purposes
        set out in this Privacy Notice, unless a longer retention period is required or permitted
        by law (such as tax, accounting, or other legal requirements). Users and games are kept
        until you delete your user, or until we delete them. There is no other time limit, apart
        from the 30 days a session lasts unused. What deleting your user does to the games you were
        in is set out in <To id="rights">section 7</To>.
      </p>
      <p>
        When we have no ongoing legitimate business need to process your personal information, we
        will either delete or anonymize such information, or, if this is not possible (for example,
        because your personal information has been stored in backup archives), then we will
        securely store your personal information and isolate it from any further processing until
        deletion is possible.
      </p>

      <Heading id="security" />
      <InShort>
        We aim to protect your personal information through a system of organizational and
        technical security measures.
      </InShort>
      <p>
        We have implemented appropriate and reasonable technical and organizational security
        measures designed to protect the security of any personal information we process. However,
        despite our safeguards and efforts to secure your information, no electronic transmission
        over the Internet or information storage technology can be guaranteed to be 100% secure, so
        we cannot promise or guarantee that hackers, cybercriminals, or other unauthorized third
        parties will not be able to defeat our security and improperly collect, access, steal, or
        modify your information. Although we will do our best to protect your personal information,
        transmission of personal information to and from our Services is at your own risk. You
        should only access the Services within a secure environment.
      </p>

      <Heading id="rights" />
      <InShort>
        Depending on your state of residence in the US or in some regions, such as the European
        Economic Area (EEA), United Kingdom (UK), Switzerland, and Canada, you have rights that
        allow you greater access to and control over your personal information. You may review,
        change, or terminate your account at any time, depending on your country, province, or
        state of residence.
      </InShort>
      <p>
        In some regions (like the EEA, UK, Switzerland, and Canada), you have certain rights under
        applicable data protection laws. These may include the right (i) to request access and
        obtain a copy of your personal information, (ii) to request rectification or erasure; (iii)
        to restrict the processing of your personal information; (iv) if applicable, to data
        portability; and (v) not to be subject to automated decision-making. If a decision that
        produces legal or similarly significant effects is made solely by automated means, we will
        inform you, explain the main factors, and offer a simple way to request human review. In
        certain circumstances, you may also have the right to object to the processing of your
        personal information. You can make such a request by contacting us by using the contact
        details provided in the section “<To id="contact">How can you contact us about this
        notice?</To>” below.
      </p>
      <p>
        We will consider and act upon any request in accordance with applicable data protection
        laws.
      </p>
      <p>
        If you are located in the UK and are unhappy with how we have handled your personal
        information, you can make a complaint directly to us. This is in addition to the rights you
        have under the UK General Data Protection Regulation and the Data Protection Act 2018.
      </p>
      <p>How to contact us:</p>
      <ul>
        <li>Email: {mail}</li>
        <li>
          Post: See “<To id="contact">How can you contact us about this notice?</To>”
        </li>
      </ul>
      <p>
        <strong>What happens after you complain</strong>
      </p>
      <ul>
        <li>We will acknowledge your complaint within 30 days of receiving it.</li>
        <li>We will investigate without unjustifiable or excessive delay.</li>
        <li>We will keep you informed of progress and explain the outcome.</li>
        <li>
          If you are not happy with our final response, you can refer your complaint to the
          Information Commissioner’s Office, the UK supervisory authority.
          <ul>
            <li>
              Website:{" "}
              <a href="https://ico.org.uk/make-a-complaint">ico.org.uk/make-a-complaint</a>
            </li>
            <li>Helpline: 0303 123 1113</li>
            <li>
              Post: Information Commissioner’s Office, Wycliffe House, Water Lane, Wilmslow,
              Cheshire, SK9 5AF
            </li>
          </ul>
        </li>
      </ul>
      <p>
        If you are located in the EEA or UK and you believe we are unlawfully processing your
        personal information, you also have the right to complain to your Member State data
        protection authority or UK data protection authority.
      </p>
      <p>
        If you are located in Switzerland, you may contact the Federal Data Protection and
        Information Commissioner.
      </p>
      <p id="withdrawing-consent">
        <strong>Withdrawing your consent:</strong> If we are relying on your consent to process
        your personal information, which may be express and/or implied consent depending on the
        applicable law, you have the right to withdraw your consent at any time. You can withdraw
        your consent at any time by contacting us by using the contact details provided in the
        section “<To id="contact">How can you contact us about this notice?</To>” below.
      </p>
      <p>
        However, please note that this will not affect the lawfulness of the processing before its
        withdrawal nor, when applicable law allows, will it affect the processing of your personal
        information conducted in reliance on lawful processing grounds other than consent.
      </p>

      <h3>Account information</h3>
      <p>
        If you would at any time like to review or change the information in your account or
        terminate your account, you can:
      </p>
      <ul>
        <li>
          If you are a guest, you can change your display name at any time, from the account menu in
          the top right corner. The name of an account is its username, which can’t be changed.
        </li>
        <li>You can sign out from the same menu, which ends that browser’s session.</li>
        <li>
          <strong>You can delete your user</strong> from the same menu, whether you have an account
          or are a guest. Your username (your name), password hash, sessions and display name are
          deleted. Games you are playing against another person are forfeited, so they win, and
          stay for them with you shown as “Deleted player”, as do your finished games against other
          people. Games against the bot, and games nobody else has joined, are deleted. It can’t be
          undone.
        </li>
        <li>
          Clearing this site’s data in your browser makes it forget you. If you are a guest, the
          next visit starts a new anonymous user, and the games of the old one can’t be opened
          again. They stay on the server. If you have an account, you sign in again.
        </li>
        <li>To have your games deleted, write to {mail} with the links to them.</li>
      </ul>
      <p>
        If you ask us to terminate your account instead, we will deactivate or delete your account
        and information from our active databases. However, we may retain some information in our
        files to prevent fraud, troubleshoot problems, assist with any investigations, enforce our
        legal terms and/or comply with applicable legal requirements.
      </p>
      <p>
        If you have questions or comments about your privacy rights, you may email us at {mail}.
      </p>

      <Heading id="do-not-track" />
      <p>
        Most web browsers and some mobile operating systems and mobile applications include a
        Do-Not-Track (“DNT”) feature or setting you can activate to signal your privacy preference
        not to have data about your online browsing activities monitored and collected. At this
        stage, no uniform technology standard for recognizing and implementing DNT signals has been
        finalized. As such, we do not currently respond to DNT browser signals or any other
        mechanism that automatically communicates your choice not to be tracked online. If a
        standard for online tracking is adopted that we must follow in the future, we will inform
        you about that practice in a revised version of this Privacy Notice.
      </p>
      <p>
        California law requires us to let you know how we respond to web browser DNT signals.
        Because there currently is not an industry or legal standard for recognizing or honoring
        DNT signals, we do not respond to them at this time.
      </p>

      <Heading id="us-rights" />
      <InShort>
        If you are a resident of California, Colorado, Connecticut, Delaware, Florida, Indiana,
        Iowa, Kentucky, Maryland, Minnesota, Montana, Nebraska, New Hampshire, New Jersey, Oregon,
        Rhode Island, Tennessee, Texas, Utah, or Virginia, you may have the right to request access
        to and receive details about the personal information we maintain about you and how we have
        processed it, correct inaccuracies, get a copy of, or delete your personal information. You
        may also have the right to withdraw your consent to our processing of your personal
        information. These rights may be limited in some circumstances by applicable law. More
        information is provided below.
      </InShort>

      <h3>Categories of personal information we collect</h3>
      <p>
        The table below shows the categories of personal information we have collected in the past
        twelve (12) months. The table includes illustrative examples of each category and does not
        reflect the personal information we collect from you. For a comprehensive inventory of all
        personal information we process, please refer to the section “
        <To id="information">What information do we collect?</To>”
      </p>
      <table>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Examples</th>
            <th scope="col">Collected</th>
          </tr>
        </thead>
        <tbody>
          {CATEGORIES.map(({ name, examples, collected }) => (
            <tr key={name}>
              <th scope="row">{name}</th>
              <td>{examples}</td>
              <td>{collected ? "Yes" : "No"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p>
        Identifiers here are your username, your user id and access token, and the IP address in a
        host’s access logs. Network activity is the games you play and your moves in them.
      </p>
      <p>
        We may also collect other personal information outside of these categories through
        instances where you interact with us in person, online, or by phone or mail in the context
        of:
      </p>
      <ul>
        <li>Receiving help through our customer support channels;</li>
        <li>Participation in customer surveys or contests; and</li>
        <li>Facilitation in the delivery of our Services and to respond to your inquiries.</li>
      </ul>

      <h3>Sources of personal information</h3>
      <p>
        Learn more about the sources of personal information we collect in “
        <To id="information">What information do we collect?</To>”
      </p>

      <h3>How we use and share personal information</h3>
      <p>
        Learn more about how we use your personal information in the section, “
        <To id="processing">How do we process your information?</To>”
      </p>
      <p>
        <strong>Will your information be shared with anyone else?</strong>
      </p>
      <p>
        We may disclose your personal information with our service providers pursuant to a written
        contract between us and each service provider. Learn more about how we disclose personal
        information in the section, “
        <To id="sharing">When and with whom do we share your personal information?</To>”
      </p>
      <p>
        We may use your personal information for our own business purposes, such as for undertaking
        internal research for technological development and demonstration. This is not considered
        to be “selling” of your personal information.
      </p>
      <p>
        We have not disclosed, sold, or shared any personal information to third parties for a
        business or commercial purpose in the preceding twelve (12) months. We will not sell or
        share personal information in the future belonging to website visitors, users, and other
        consumers.
      </p>

      <h3>Your rights</h3>
      <p>
        You have rights under certain US state data protection laws. However, these rights are not
        absolute, and in certain cases, we may decline your request as permitted by law. These
        rights include:
      </p>
      <ul>
        <li>Right to know whether or not we are processing your personal data</li>
        <li>Right to access your personal data</li>
        <li>Right to correct inaccuracies in your personal data</li>
        <li>Right to request the deletion of your personal data</li>
        <li>Right to obtain a copy of the personal data you previously shared with us</li>
        <li>Right to non-discrimination for exercising your rights</li>
        <li>
          Right to opt out of the processing of your personal data if it is used for targeted
          advertising (or sharing as defined under California’s privacy law), the sale of personal
          data, or profiling in furtherance of decisions that produce legal or similarly significant
          effects (“profiling”)
        </li>
      </ul>
      <p>Depending upon the state where you live, you may also have the following rights:</p>
      <ul>
        <li>
          Right to access the categories of personal data being processed (as permitted by
          applicable law, including the privacy law in Minnesota)
        </li>
        <li>
          Right to obtain a list of the categories of third parties to which we have disclosed
          personal data (as permitted by applicable law, including the privacy law in California,
          Delaware, and Maryland)
        </li>
        <li>
          Right to obtain a list of specific third parties to which we have disclosed personal data
          (as permitted by applicable law, including the privacy law in Minnesota and Oregon)
        </li>
        <li>
          Right to obtain a list of third parties to which we have sold personal data (as permitted
          by applicable law, including the privacy law in Connecticut)
        </li>
        <li>
          Right to review, understand, question, and depending on where you live, correct how
          personal data has been profiled (as permitted by applicable law, including the privacy law
          in Connecticut and Minnesota)
        </li>
        <li>
          Right to limit use and disclosure of sensitive personal data (as permitted by applicable
          law, including the privacy law in California)
        </li>
        <li>
          Right to opt out of the collection of sensitive data and personal data collected through
          the operation of a voice or facial recognition feature (as permitted by applicable law,
          including the privacy law in Florida)
        </li>
      </ul>

      <h3>How to exercise your rights</h3>
      <p>
        To exercise these rights, you can contact us by emailing us at {mail}, or by referring to
        the contact details in the section “
        <To id="contact">How can you contact us about this notice?</To>”
      </p>
      <p>
        Under certain US state data protection laws, you can designate an authorized agent to make
        a request on your behalf. We may deny a request from an authorized agent that does not
        submit proof that they have been validly authorized to act on your behalf in accordance
        with applicable laws.
      </p>

      <h3>Request verification</h3>
      <p>
        Upon receiving your request, we will need to verify your identity to determine you are the
        same person about whom we have the information in our system. We will only use personal
        information provided in your request to verify your identity or authority to make the
        request. However, if we cannot verify your identity from the information already maintained
        by us, we may request that you provide additional information for the purposes of verifying
        your identity and for security or fraud-prevention purposes.
      </p>
      <p>
        If you submit the request through an authorized agent, we may need to collect additional
        information to verify your identity before processing your request and the agent will need
        to provide a written and signed permission from you to submit such request on your behalf.
      </p>

      <h3>Appeals</h3>
      <p>
        Under certain US state data protection laws, if we decline to take action regarding your
        request, you may appeal our decision by emailing us at {mail}. We will inform you in
        writing of any action taken or not taken in response to the appeal, including a written
        explanation of the reasons for the decisions. If your appeal is denied, you may submit a
        complaint to your state attorney general.
      </p>

      <h3>California “Shine The Light” law</h3>
      <p>
        California Civil Code Section 1798.83, also known as the “Shine The Light” law, permits our
        users who are California residents to request and obtain from us, once a year and free of
        charge, information about categories of personal information (if any) we disclosed to third
        parties for direct marketing purposes and the names and addresses of all third parties with
        which we shared personal information in the immediately preceding calendar year. If you are
        a California resident and would like to make such a request, please submit your request in
        writing to us by using the contact details provided in the section “
        <To id="contact">How can you contact us about this notice?</To>”
      </p>

      <Heading id="updates" />
      <InShort>Yes, we will update this notice as necessary to stay compliant with relevant laws.</InShort>
      <p>
        We may update this Privacy Notice from time to time. The updated version will be indicated
        by an updated “Last updated” date at the top of this Privacy Notice. If we make material
        changes to this Privacy Notice, we may notify you either by prominently posting a notice of
        such changes or by directly sending you a notification. We encourage you to review this
        Privacy Notice frequently to be informed of how we are protecting your information.
      </p>

      <Heading id="contact" />
      <p>
        If you have questions or comments about this notice, you may email us at {mail} or contact
        us by post at:
      </p>
      <p>
        {[operator.name, ...operator.address].map((line, index) => (
          <Fragment key={line}>
            {index > 0 && <br />}
            {line}
          </Fragment>
        ))}
      </p>

      <Heading id="review" />
      <p>
        You have the right to request access to the personal information we collect from you,
        details about how we have processed it, correct inaccuracies, or delete your personal
        information. You may also have the right to withdraw your consent to our processing of your
        personal information. These rights may be limited in some circumstances by applicable law.
        To request to review, update, or delete your personal information, please write to {mail}.
        You can also delete your user yourself, from the account menu: see{" "}
        <To id="rights">section 7</To>.
      </p>

      <p>
        <Link to="/">← Back to the games</Link>
      </p>
    </main>
  );
}
