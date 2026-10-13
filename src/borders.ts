/**
 * Cross-border connections per region with SMARD's series ids.
 *
 * Generated from SMARD's module configuration
 * (https://www.smard.de/app/chart_configuration/market_data_configuration.json,
 * categories "Physikalischer Stromfluss" and "Kommerzieller Außenhandel")
 * on 2026-10-13. Exports are positive, imports negative (MWh per interval),
 * checked against SMARD's CSV export. For a TSO zone only the connections of
 * that zone to other countries are listed; exchanges between the German
 * zones are not part of SMARD's flow data.
 */

export interface Border {
  region: "DE" | "50Hertz" | "Amprion" | "TenneT" | "TransnetBW";
  /** Country or bidding zone code, e.g. FR, DK1. */
  code: string;
  name: string;
  physical: { export: number; import: number };
  commercial: { export: number; import: number };
}

/** Net export (exports + imports) across all borders of a region. */
export const NET_EXPORT_FILTER = { physical: 4963, commercial: 4629 } as const;

export const BORDERS: readonly Border[] = [
  { region: "DE", code: "AT", name: "Austria", physical: { export: 4740, import: 4884 }, commercial: { export: 4407, import: 4549 } },
  { region: "DE", code: "BE", name: "Belgium", physical: { export: 4992, import: 4994 }, commercial: { export: 4998, import: 4712 } },
  { region: "DE", code: "CH", name: "Switzerland", physical: { export: 4743, import: 4887 }, commercial: { export: 4410, import: 4552 } },
  { region: "DE", code: "CZ", name: "Czech Republic", physical: { export: 4744, import: 4888 }, commercial: { export: 4412, import: 4553 } },
  { region: "DE", code: "DK", name: "Denmark", physical: { export: 4736, import: 4880 }, commercial: { export: 4403, import: 4545 } },
  { region: "DE", code: "FR", name: "France", physical: { export: 4737, import: 4881 }, commercial: { export: 4404, import: 4546 } },
  { region: "DE", code: "LU", name: "Luxembourg", physical: { export: 4738, import: 4882 }, commercial: { export: 4405, import: 4547 } },
  { region: "DE", code: "NL", name: "Netherlands", physical: { export: 4739, import: 4883 }, commercial: { export: 4406, import: 4548 } },
  { region: "DE", code: "NO", name: "Norway", physical: { export: 4988, import: 4990 }, commercial: { export: 4722, import: 4724 } },
  { region: "DE", code: "PL", name: "Poland", physical: { export: 4741, import: 4885 }, commercial: { export: 4408, import: 4550 } },
  { region: "DE", code: "SE", name: "Sweden", physical: { export: 4742, import: 4886 }, commercial: { export: 4409, import: 4551 } },
  { region: "50Hertz", code: "CZ", name: "Czech Republic", physical: { export: 4754, import: 4896 }, commercial: { export: 4417, import: 4556 } },
  { region: "50Hertz", code: "DK2", name: "Denmark 2", physical: { export: 4752, import: 4894 }, commercial: { export: 4415, import: 4554 } },
  { region: "50Hertz", code: "PL", name: "Poland", physical: { export: 4753, import: 4895 }, commercial: { export: 4416, import: 4555 } },
  { region: "Amprion", code: "AT", name: "Austria", physical: { export: 4759, import: 4900 }, commercial: { export: 4421, import: 4560 } },
  { region: "Amprion", code: "BE", name: "Belgium", physical: { export: 4968, import: 4970 }, commercial: { export: 4702, import: 4704 } },
  { region: "Amprion", code: "CH", name: "Switzerland", physical: { export: 4760, import: 4901 }, commercial: { export: 4422, import: 4561 } },
  { region: "Amprion", code: "FR", name: "France", physical: { export: 4755, import: 4897 }, commercial: { export: 4418, import: 4557 } },
  { region: "Amprion", code: "LU", name: "Luxembourg", physical: { export: 4756, import: 4898 }, commercial: { export: 4419, import: 4558 } },
  { region: "Amprion", code: "NL", name: "Netherlands", physical: { export: 4757, import: 4899 }, commercial: { export: 4420, import: 4559 } },
  { region: "TenneT", code: "AT", name: "Austria", physical: { export: 4763, import: 4904 }, commercial: { export: 4425, import: 4564 } },
  { region: "TenneT", code: "CZ", name: "Czech Republic", physical: { export: 4765, import: 4906 }, commercial: { export: 4427, import: 4566 } },
  { region: "TenneT", code: "DK1", name: "Denmark 1", physical: { export: 4761, import: 4902 }, commercial: { export: 4423, import: 4562 } },
  { region: "TenneT", code: "NL", name: "Netherlands", physical: { export: 4762, import: 4903 }, commercial: { export: 4424, import: 4563 } },
  { region: "TenneT", code: "NO", name: "Norway", physical: { export: 4964, import: 4966 }, commercial: { export: 4714, import: 4716 } },
  { region: "TenneT", code: "SE4", name: "Sweden 4", physical: { export: 4764, import: 4905 }, commercial: { export: 4426, import: 4565 } },
  { region: "TransnetBW", code: "AT", name: "Austria", physical: { export: 4767, import: 4908 }, commercial: { export: 4429, import: 4568 } },
  { region: "TransnetBW", code: "CH", name: "Switzerland", physical: { export: 4768, import: 4909 }, commercial: { export: 4430, import: 4569 } },
  { region: "TransnetBW", code: "FR", name: "France", physical: { export: 4766, import: 4907 }, commercial: { export: 4428, import: 4567 } },
];
