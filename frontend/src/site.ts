/** Who runs the site, as the privacy page tells its readers. */
export interface Operator {
  /** The company that runs the site. */
  name: string;
  /** Where people write to it, about the site's data and anything else on the privacy page. */
  email: string;
  /** Where the site is, as the privacy page names it: with the scheme, and the slash at the end. */
  url: string;
  /** The company's postal address, one line to each element. */
  address: string[];
}

export const OPERATOR: Operator = {
  name: "Seequ Oy",
  email: "support@seequ.dev",
  url: "https://games.seequ.dev/",
  address: ["PL 14", "Oulu 90571", "Finland"],
};
