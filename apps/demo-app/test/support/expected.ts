/** The seeded fixture as the healthy exporter must write it: amounts normalized, RFC 4180 quoting, CRLF. */
export const EXPECTED_SOURCE_EXPORT = [
  'voucher_number,amount,check_date,department_name,contract_number,vendor_name',
  'PV05210004178,17104.23,03/17/2021,DEPT OF STREETS AND SANITATION,32108,"ACME WASTE, INC."',
  ',19038.00,2003,,DV,Café Núñez',
  'PV07210012345,-5.10,12/31/2020,DEPT OF FINANCE,DV,"Smith ""Bros"" Hauling LLC"',
  'PV08210000001,250.00,02/29/2024,CHICAGO PUBLIC LIBRARY,27411,"North Shore Books\nAnnex"',
  'PV09210004444,1200.50,07/04/2022,DEPT OF AVIATION,30022,UNITED MAINTENANCE CO',
  'PV09210004444,1200.50,07/04/2022,DEPT OF AVIATION,30022,UNITED MAINTENANCE CO',
  "PV10210000777,0.07,11/05/2019,DEPT OF WATER MANAGEMENT,DV,O'BRIEN PLUMBING",
]
  .map((line) => `${line}\r\n`)
  .join('');

export const FIXTURE_PAYMENT_COUNT = 7;
