// Fixtures mirroring the Kalshi /events?with_nested_markets=true shape.
// Scenario: NBA Finals game 7 — Thunder (OKC) vs Pacers (IND).

export function gameEvent(overrides = {}) {
  return {
    event_ticker: "KXNBAGAME-26JUN15OKCIND",
    series_ticker: "KXNBAGAME",
    title: "Thunder vs Pacers Winner?",
    markets: [
      market({ ticker: "KXNBAGAME-26JUN15OKCIND-OKC", yes_sub_title: "Oklahoma City Thunder", yes_bid: 60, yes_ask: 62 }),
      market({ ticker: "KXNBAGAME-26JUN15OKCIND-IND", yes_sub_title: "Indiana Pacers", yes_bid: 37, yes_ask: 39 }),
    ],
    ...overrides,
  };
}

// Series-winner event whose close time coincides with game 7 —
// winning the game IS winning the series.
export function seriesEvent(overrides = {}) {
  return {
    event_ticker: "KXNBASERIES-26FINALS",
    series_ticker: "KXNBASERIES",
    title: "NBA Finals Series Winner",
    markets: [
      market({ ticker: "KXNBASERIES-26FINALS-OKC", yes_sub_title: "Oklahoma City Thunder", yes_bid: 54, yes_ask: 56 }),
      market({ ticker: "KXNBASERIES-26FINALS-IND", yes_sub_title: "Indiana Pacers", yes_bid: 42, yes_ask: 44 }),
    ],
    ...overrides,
  };
}

export function market(overrides = {}) {
  return {
    ticker: "KXNBAGAME-26JUN15OKCIND-OKC",
    title: "",
    yes_sub_title: "",
    yes_bid: 50,
    yes_ask: 52,
    no_bid: 48,
    no_ask: 50,
    volume: 1000,
    close_time: "2026-06-16T03:00:00Z",
    created_time: "2026-06-01T12:00:00Z",
    ...overrides,
  };
}

export function spreadEvent(overrides = {}) {
  return {
    event_ticker: "KXNBASPREAD-26JUN15OKCIND",
    series_ticker: "KXNBASPREAD",
    title: "Thunder vs Pacers Spread",
    markets: [
      market({ ticker: "KXNBASPREAD-26JUN15OKCIND-OKC1", title: "Thunder wins by over 1.5 Points", yes_bid: 55, yes_ask: 57 }),
    ],
    ...overrides,
  };
}
