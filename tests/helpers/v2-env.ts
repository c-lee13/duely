/** Import FIRST: selects the v2 deployment in live mode before any module that reads configuration is evaluated. */
process.env.DUELY_DEPLOYMENT = "v2"
process.env.NEXT_PUBLIC_DUELY_DEPLOYMENT = "v2"
process.env.NEXT_PUBLIC_DATA_MODE = "api"
