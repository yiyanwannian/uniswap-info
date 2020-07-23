import { USER_MINTS_BUNRS_PER_PAIR, USER_HISTORY__PER_PAIR } from '../apollo/queries'
import { client } from '../apollo/client'
import dayjs from 'dayjs'
import { getShareValueOverTime } from '.'

export const priceOverrides = [
  '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
  '0x6b175474e89094c44da98b954eedeac495271d0f' // DAI
]

interface ReturnMetrics {
  hodleReturn: number // difference in asset values t0 -> t1 with t0 deposit amounts
  netReturn: number // net return from t0 -> t1
  uniswapReturn: number // netReturn - hodlReturn
  impLoss: number
  fees: number
}

// used to calculate returns within a given window bounded by two positions
interface Position {
  liquidityTokenBalance: number
  liquidityTokenTotalSupply: number
  reserve0: number
  reserve1: number
  reserveUSD: number
  token0PriceUSD: number
  token1PriceUSD: number
}

const PRICE_DISCOVERY_START_TIMESTAMP = 1589747086

function formatPricesForEarlyTimestamps(position): Position {
  if (position.timestamp < PRICE_DISCOVERY_START_TIMESTAMP) {
    if (priceOverrides.includes(position.pair.token0.id)) {
      position.token0PriceUSD = 1
    }
    if (priceOverrides.includes(position.pair.token1.id)) {
      position.token1PriceUSD = 1
    }
    // WETH price
    if (position.pair.token0.id === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') {
      position.token0PriceUSD = 203
    }
    if (position.pair.token1.id === '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2') {
      position.token1PriceUSD = 203
    }
  }
  return position
}

async function getPrincipalForUserPerPair(user: string, pairAddress: string) {
  let usd = 0
  let amount0 = 0
  let amount1 = 0
  // get all minst and burns to get principal amounts
  const results = await client.query({
    query: USER_MINTS_BUNRS_PER_PAIR,
    variables: {
      user,
      pair: pairAddress
    }
  })
  for (const index in results.data.mints) {
    const mint = results.data.mints[index]
    const mintToken0 = mint.pair.token0.id
    const mintToken1 = mint.pair.token1.id

    // if trackign before prices were discovered (pre-launch days), hardcode stablecoins
    if (priceOverrides.includes(mintToken0) && mint.timestamp < PRICE_DISCOVERY_START_TIMESTAMP) {
      usd += parseFloat(mint.amount0) * 2
    } else if (priceOverrides.includes(mintToken1) && mint.timestamp < PRICE_DISCOVERY_START_TIMESTAMP) {
      usd += parseFloat(mint.amount1) * 2
    } else {
      usd += parseFloat(mint.amountUSD)
    }
    amount0 += amount0 + parseFloat(mint.amount0)
    amount1 += amount1 + parseFloat(mint.amount1)
  }

  for (const index in results.data.burns) {
    const burn = results.data.mints[index]
    const burnToken0 = burn.pair.token0.id
    const burnToken1 = burn.pair.token1.id

    // if trackign before prices were discovered (pre-launch days), hardcode stablecoins
    if (priceOverrides.includes(burnToken0) && burn.timestamp < PRICE_DISCOVERY_START_TIMESTAMP) {
      usd += parseFloat(burn.amount0) * 2
    } else if (priceOverrides.includes(burnToken1) && burn.timestamp < PRICE_DISCOVERY_START_TIMESTAMP) {
      usd += parseFloat(burn.amount1) * 2
    } else {
      usd -= parseFloat(results.data.burns[index].amountUSD)
    }

    amount0 -= parseFloat(results.data.burns[index].amount0)
    amount1 -= parseFloat(results.data.burns[index].amount1)
  }

  return { usd, amount0, amount1 }
}

export async function getLPReturnsOnPair(user: string, pair, ethPrice: number) {
  // initialize values
  const principal = await getPrincipalForUserPerPair(user, pair.id)
  let hodlReturn = 0
  let netReturn = 0
  let uniswapReturn = 0

  // get snapshots of position changes on this pair for this user
  const {
    data: { liquidityPositionSnapshots: history }
  } = await client.query({
    query: USER_HISTORY__PER_PAIR,
    variables: {
      user,
      pair: pair.id
    }
  })

  // get data about the current position
  const currentPosition: Position = {
    liquidityTokenBalance: history[history.length - 1].liquidityTokenBalance,
    liquidityTokenTotalSupply: pair.totalSupply,
    reserve0: pair.reserve0,
    reserve1: pair.reserve1,
    reserveUSD: pair.reserveUSD,
    token0PriceUSD: pair.token0.derivedETH * ethPrice,
    token1PriceUSD: pair.token1.derivedETH * ethPrice
  }

  for (const index in history) {
    // get positions at both bounds of the window
    let positionT0 = formatPricesForEarlyTimestamps(history[index])
    let positionT1 = formatPricesForEarlyTimestamps(
      parseInt(index) === history.length - 1 ? currentPosition : history[parseInt(index) + 1]
    )

    let results = getMetricsForPositionWindow(positionT0, positionT1, pair.id)
    hodlReturn = hodlReturn + results.hodleReturn
    netReturn = netReturn + results.netReturn

    uniswapReturn = uniswapReturn + results.uniswapReturn
  }

  return {
    principal,
    hodl: {
      sum: principal.usd + hodlReturn, // change with multiple windows
      return: hodlReturn
    },
    net: {
      return: netReturn
    },
    uniswap: {
      return: uniswapReturn
    }
  }
}
/**
 * Core algorithm for calculating retursn within one time window.
 * @param positionT0 // users liquidity info and token rates at beginning of window
 * @param positionT1 // '' at the end of the window
 */
export function getMetricsForPositionWindow(positionT0: Position, positionT1: Position, pair = null): ReturnMetrics {
  // calculate ownership at ends of window, for end of window we need original LP token balance / new total supply
  const t0Ownership = positionT0.liquidityTokenBalance / positionT0.liquidityTokenTotalSupply
  const t1Ownership = positionT0.liquidityTokenBalance / positionT1.liquidityTokenTotalSupply

  // get starting amounts of token0 and token1 deposited by LP
  const token0_amount_t0 = t0Ownership * positionT0.reserve0
  const token1_amount_t0 = t0Ownership * positionT0.reserve1

  // get current token values
  const token0_amount_t1 = t1Ownership * positionT1.reserve0
  const token1_amount_t1 = t1Ownership * positionT1.reserve1

  // calculate squares to find imp loss and fee differences
  const sqrK_t0 = Math.sqrt(positionT1.token1PriceUSD)
  const token0_amount_no_fees = positionT1.token1PriceUSD ? sqrK_t0 * Math.sqrt(positionT1.token1PriceUSD) : 0
  const token1_amount_no_fees = Number(positionT1.token1PriceUSD) ? sqrK_t0 / Math.sqrt(positionT1.token1PriceUSD) : 0
  const no_fees_usd =
    token0_amount_no_fees * positionT1.token0PriceUSD + token1_amount_no_fees * positionT1.token1PriceUSD

  const difference_fees_token0 = token0_amount_t1 - token0_amount_no_fees
  const difference_fees_token1 = token1_amount_t1 - token1_amount_no_fees
  const difference_fees_usd =
    difference_fees_token0 * positionT1.token0PriceUSD + difference_fees_token1 * positionT1.token1PriceUSD

  // calculate USD value at t0 and t1 using initial token deposit amounts for asset return
  const assetValueT0 = token0_amount_t0 * positionT0.token0PriceUSD + token1_amount_t0 * positionT0.token1PriceUSD
  const assetValueT1 = token0_amount_t0 * positionT1.token0PriceUSD + token1_amount_t0 * positionT1.token1PriceUSD

  const imp_loss_usd = no_fees_usd - assetValueT1

  const uniswap_return = difference_fees_usd + imp_loss_usd

  // get net value change for combined data
  const netValueT0 = t0Ownership * positionT0.reserveUSD
  const netValueT1 = t1Ownership * positionT1.reserveUSD

  return {
    hodleReturn: assetValueT1 - assetValueT0,
    netReturn: netValueT1 - netValueT0,
    uniswapReturn: uniswap_return,
    impLoss: imp_loss_usd,
    fees: difference_fees_usd
  }
}

export async function getReturnsHistoryPerLPPerPair(
  startDateTimestamp,
  currentPairData,
  pairSnapshots,
  currentETHPrice
) {
  let dayIndex: number = Math.round(startDateTimestamp / 86400) // get unique day bucket unix
  const currentDayIndex: number = Math.round(dayjs.utc().unix() / 86400)

  // sort snapshots in order
  let sortedPositions = pairSnapshots.sort((a, b) => {
    return parseInt(a.timestamp) > parseInt(b.timestamp) ? 1 : -1
  })

  // if UI start time is < first position time - bump start index to position date
  if (sortedPositions[0].timestamp > dayIndex) {
    dayIndex = Math.round(sortedPositions[0].timestamp / 86400)
  }

  const dayTimestamps = []
  // get date timestamps for all days in view
  while (dayIndex < currentDayIndex) {
    dayTimestamps.push(dayIndex * 86400)
    dayIndex = dayIndex + 1
  }

  const shareValues = await getShareValueOverTime(currentPairData.id, dayTimestamps)
  const formattedHistory = []

  // keep track of up to date metrics as we parse each day
  let returns = {
    lastUpdated: sortedPositions[0].timestamp,
    liquidityTokenBalance: parseFloat(sortedPositions[0].liquidityTokenBalance),
    liquidityTokenTotalSupply: parseFloat(sortedPositions[0].liquidityTokenTotalSupply),
    reserve0: parseFloat(sortedPositions[0].reserve0),
    reserve1: parseFloat(sortedPositions[0].reserve1),
    reserveUSD: parseFloat(sortedPositions[0].reserveUSD),
    token0PriceUSD: parseFloat(sortedPositions[0].token0PriceUSD),
    token1PriceUSD: parseFloat(sortedPositions[0].token1PriceUSD),
    assetReturn: 0,
    uniswapReturn: 0,
    netReturn: 0,
    assetChange: 0,
    uniswapChange: 0,
    netChange: 0
  }

  for (const index in dayTimestamps) {
    const dayTimestamp = dayTimestamps[index]
    const timestampCeiling = dayTimestamp + 86400

    const shareValue = shareValues[index]

    const positionT0: Position = returns
    let positionT1: Position = {
      liquidityTokenBalance: returns.liquidityTokenBalance,
      liquidityTokenTotalSupply: shareValue.totalSupply,
      reserve0: shareValue.reserve0,
      reserve1: shareValue.reserve1,
      reserveUSD: shareValue.reserveUSD,
      token0PriceUSD: shareValue.token0PriceUSD,
      token1PriceUSD: shareValue.token1PriceUSD
    }

    // if today , use latest data instead of last day data
    if (parseInt(index) === dayTimestamps.length - 1) {
      positionT1 = currentPairData
      positionT1.liquidityTokenTotalSupply = currentPairData.totalSupply
      positionT1.token0PriceUSD = parseFloat(currentPairData.token0.derivedETH) * currentETHPrice
      positionT1.token1PriceUSD = parseFloat(currentPairData.token1.derivedETH) * currentETHPrice
    }

    // get position changes on this day
    const positionChanges = pairSnapshots?.filter(snapshot => {
      return snapshot.timestamp < timestampCeiling && snapshot.timestamp > dayTimestamp
    })

    let needsUpdate = false
    // find latest change, and use that as end of window for today
    for (const index in positionChanges) {
      const positionChange = positionChanges[index]
      // case where more recent timestamp is found for pair
      if (returns.lastUpdated < positionChange.timestamp) {
        returns.lastUpdated = positionChange.timestamp
        positionT1 = positionChange
        needsUpdate = true
      }
    }
    const calculatedReturns = getMetricsForPositionWindow(positionT0, positionT1)

    // account for profits or loss because position actually changed here
    if (needsUpdate) {
      returns.netReturn = returns.netReturn + calculatedReturns.netReturn
      returns.assetReturn = returns.assetReturn + calculatedReturns.hodleReturn
      returns.uniswapReturn = returns.uniswapReturn + calculatedReturns.uniswapReturn
    }

    const localNetReturn = returns.netReturn + calculatedReturns.netReturn
    const localAssetReturn = returns.assetReturn + calculatedReturns.hodleReturn
    const localUnsiwapReturn = returns.uniswapReturn + calculatedReturns.uniswapReturn

    const currentLiquidityValue = positionT0.liquidityTokenBalance * shareValue.sharePriceUsd

    formattedHistory.push({
      date: dayTimestamp,
      usdValue: currentLiquidityValue,
      netReturn: localNetReturn,
      assetReturn: localAssetReturn,
      uniswapReturn: localUnsiwapReturn,
      impLoss: calculatedReturns.impLoss,
      fees: calculatedReturns.fees
    })
  }

  return formattedHistory
}