/** Who runs the site, as the privacy page tells its readers. */
export interface Operator {
  /** The company that runs the site. */
  name: string;
  /** Where people write to it, about the site's data and anything else on the privacy page. */
  email: string;
}

export const OPERATOR: Operator = { name: "Seequ Oy", email: "support@seequ.dev" };
