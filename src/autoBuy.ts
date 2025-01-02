import {
    Connection,
    Keypair,
    PublicKey,
    LAMPORTS_PER_SOL,
  } from '@solana/web3.js'
  import {
    Raydium,
    TxVersion,
    Router,
    TokenAmount,
    Token,
    toFeeConfig,
    toApiV3Token,
    setLoggerLevel,
    LogLevel,
  } from '@raydium-io/raydium-sdk-v2'
  import { NATIVE_MINT, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
  import dotenv from 'dotenv'
  
  dotenv.config()
  
  /************************************************
   * Interfaces & Globals
   ************************************************/
  interface Wallet {
    publicKey: PublicKey
    secretKey: Uint8Array
  }
  
  let raydium: Raydium | undefined
  
  // 1) Validate ENV
  const RPC_ENDPOINT = process.env.RPC_ENDPOINT || ''
  if (!RPC_ENDPOINT) throw new Error('Missing RPC_ENDPOINT in .env')
  
  const CONTRACT_ADDRESS_STR = process.env.CONTRACT_ADDRESS || ''
  if (!CONTRACT_ADDRESS_STR) throw new Error('Missing CONTRACT_ADDRESS in .env')
  const CONTRACT_ADDRESS = new PublicKey(CONTRACT_ADDRESS_STR)
  
  let WALLETS: Wallet[] = []
  if (!process.env.WALLETS) throw new Error('Missing WALLETS in .env')
  try {
    WALLETS = JSON.parse(process.env.WALLETS).map((w: any) => ({
      publicKey: new PublicKey(w.publicKey),
      secretKey: Uint8Array.from(w.secretKey),
    }))
  } catch (err) {
    throw new Error(`Failed to parse WALLETS: ${err}`)
  }
  
  // Additional user-configurable parameters
  const MIN_DELAY = parseInt(process.env.MIN_DELAY || '100', 10)
  const MAX_DELAY = parseInt(process.env.MAX_DELAY || '5000', 10)
  const MIN_BUY_AMOUNT_SOL = parseFloat(process.env.MIN_BUY_AMOUNT_SOL || '0.1')
  const MAX_BUY_AMOUNT_SOL = parseFloat(process.env.MAX_BUY_AMOUNT_SOL || '3')
  
  // A small buffer for transaction fees
  const FEE_BUFFER_SOL = 0.005
  
  const connection = new Connection(RPC_ENDPOINT, {
    commitment: 'confirmed',
  })
  

  async function initRaydium() {
    if (!WALLETS.length) {
      throw new Error('No wallets available for initialization.')
    }
  
    const owner = Keypair.fromSecretKey(WALLETS[0].secretKey)
  
    setLoggerLevel('Raydium_tradeV2', LogLevel.Debug)
  
    raydium = await Raydium.load({
      owner,
      connection,
      cluster: 'devnet', // or 'mainnet-beta' for production
      disableFeatureCheck: true,
      blockhashCommitment: 'finalized',
    })
  
    console.log('Raydium SDK initialized successfully.')
  }
  
  /************************************************
   * displayWalletBalances: For logging SOL balances
   ************************************************/
  async function displayWalletBalances(wallets: Wallet[]) {
    console.log('\n--- Current Wallet Balances ---')
    for (const wallet of wallets) {
      const lamports = await connection.getBalance(wallet.publicKey)
      console.log(
        `Wallet ${wallet.publicKey.toBase58()} has ${(lamports / LAMPORTS_PER_SOL).toFixed(3)} SOL`
      )
    }
    console.log('-------------------------------\n')
  }
  
  /************************************************
   * capBuyAmount: Ensure the wallet can afford the buy
   ************************************************/
  async function capBuyAmount(wallet: Wallet, desiredAmountSOL: number): Promise<number> {
    const balanceLamports = await connection.getBalance(wallet.publicKey)
    const balanceSOL = balanceLamports / LAMPORTS_PER_SOL
  
    const maxAffordable = balanceSOL - FEE_BUFFER_SOL
    if (maxAffordable < MIN_BUY_AMOUNT_SOL) {
      return 0 // Can't afford even the minimum
    }
    return Math.min(desiredAmountSOL, maxAffordable)
  }
  
  /************************************************
   * performBuy: Core logic for route-based swaps
   ************************************************/
  async function performBuy(wallet: Wallet, finalBuySOL: number) {
    if (!raydium) {
      throw new Error('Raydium SDK is not initialized.')
    }
  
    try {
      // 1) Convert to lamports
      const amountLamports = Math.round(finalBuySOL * LAMPORTS_PER_SOL)
      const inputMint = NATIVE_MINT
      const outputMint = CONTRACT_ADDRESS
  
      console.log(
        `Wallet ${wallet.publicKey.toBase58()} is swapping ~${finalBuySOL.toFixed(
          3
        )} SOL -> token ${outputMint.toBase58()}`
      )
  
      // 2) Fetch route-pool basic info (No caching here—could be expensive if repeated)
      const poolData = await raydium.tradeV2.fetchRoutePoolBasicInfo()
  
      // 3) Get all possible routes for our pair
      const routes = raydium.tradeV2.getAllRoute({
        inputMint,
        outputMint,
        ...poolData,
      })
  
      // 4) Fetch up-to-date pool data (reserves, ticks, etc.) for the routes
      const routeData = await raydium.tradeV2.fetchSwapRoutesData({
        routes,
        inputMint,
        outputMint,
      })
  
      const {
        mintInfos,
        ammPoolsRpcInfo,
        ammSimulateCache,
        clmmPoolsRpcInfo,
        computeClmmPoolInfo,
        computePoolTickData,
        computeCpmmData,
        routePathDict,
      } = routeData
  
      // 5) Compute final routes with amounts
      const inputMintStr = inputMint.toBase58()
      const outputMintStr = outputMint.toBase58()
  
      // Use the official approach with TokenAmount, representing the input
      const swapRoutes = raydium.tradeV2.getAllRouteComputeAmountOut({
        inputTokenAmount: new TokenAmount(
          new Token({
            mint: inputMintStr,
            decimals: mintInfos[inputMintStr]?.decimals ?? 9, // Use 9 for SOL if absent
            isToken2022: mintInfos[inputMintStr]?.programId?.equals(TOKEN_2022_PROGRAM_ID) || false,
          }),
          amountLamports.toString()
        ),
        directPath: routes.directPath.map(
          (p) =>
            ammSimulateCache[p.id.toBase58()] ||
            computeClmmPoolInfo[p.id.toBase58()] ||
            computeCpmmData[p.id.toBase58()]
        ),
        routePathDict,
        simulateCache: ammSimulateCache,
        tickCache: computePoolTickData,
        mintInfos,
        outputToken: toApiV3Token({
          ...mintInfos[outputMintStr],
          programId: mintInfos[outputMintStr].programId.toBase58(),
          address: outputMintStr,
          freezeAuthority: undefined,
          mintAuthority: undefined,
          extensions: {
            feeConfig: toFeeConfig(mintInfos[outputMintStr].feeConfig),
          },
        }),
        chainTime: Math.floor(raydium.chainTimeData?.chainTime ?? Date.now() / 1000),
        slippage: 0.005, // e.g. 0.5%
        epochInfo: await raydium.connection.getEpochInfo(),
      })
  
      if (!swapRoutes.length) {
        throw new Error('No swap routes found for this pair.')
      }
  
      // Best route is the first
      const bestRoute = swapRoutes[0]
      console.log('Best route:', {
        in: bestRoute.amountIn.amount.toExact(),
        out: bestRoute.amountOut.amount.toExact(),
        routeType: bestRoute.routeType,
      })
  
      // 6) Compute pool keys
      const poolKeys = await raydium.tradeV2.computePoolToPoolKeys({
        pools: bestRoute.poolInfoList,
        ammRpcData: ammPoolsRpcInfo,
        clmmRpcData: clmmPoolsRpcInfo,
      })
  
      // 7) Build the swap transaction
      const { execute } = await raydium.tradeV2.swap({
        routeProgram: Router,
        txVersion: TxVersion.V0,
        swapInfo: bestRoute,
        swapPoolKeys: poolKeys,
        ownerInfo: {
          associatedOnly: true,
          checkCreateATAOwner: true,
        },
        computeBudgetConfig: {
          units: 600_000,
          microLamports: 1000,
        },
      })
  
      // 8) Execute transaction(s)
      const { txIds } = await execute({ sequentially: true })
      console.log(`Swap successful for ${wallet.publicKey.toBase58()}:`)
      txIds.forEach((txId) => console.log(`    https://solscan.io/tx/${txId}?cluster=devnet`))
    } catch (error) {
      console.error(`Error in performBuy for wallet ${wallet.publicKey.toBase58()}`, error)
    }
  }
  
  /************************************************
   * runAutoBuy: Orchestrate random buys + delays
   ************************************************/
  async function runAutoBuy() {
    console.log(`\n--- Starting auto-buy for ${WALLETS.length} wallet(s) ---\n`)
    for (const wallet of WALLETS) {
      // 1) Pick random buy amount
      const desiredAmountSOL =
        Math.random() * (MAX_BUY_AMOUNT_SOL - MIN_BUY_AMOUNT_SOL) + MIN_BUY_AMOUNT_SOL
  
      // 2) Cap the buy amount based on the wallet’s balance
      const finalAmountSOL = await capBuyAmount(wallet, desiredAmountSOL)
      if (finalAmountSOL < MIN_BUY_AMOUNT_SOL) {
        console.warn(
          `Wallet ${wallet.publicKey.toBase58()} cannot afford min buy of ${MIN_BUY_AMOUNT_SOL} SOL. Skipping.`
        )
        continue
      }
  
      // 3) Random delay
      const randomDelay = Math.floor(Math.random() * (MAX_DELAY - MIN_DELAY + 1)) + MIN_DELAY
      console.log(
        `Wallet ${wallet.publicKey.toBase58()} will buy ~${finalAmountSOL.toFixed(
          3
        )} SOL in ${randomDelay}ms.`
      )
  
      // 4) Perform the buy after the delay
      setTimeout(async () => {
        await performBuy(wallet, finalAmountSOL)
      }, randomDelay)
    }
  }
  
  /************************************************
   * Main Entrypoint
   ************************************************/
  ;(async () => {
    try {
      console.log('Fetching initial balances...')
      await displayWalletBalances(WALLETS)
  
      console.log('Initializing Raydium SDK...')
      await initRaydium()
  
      console.log('Starting the auto-buy process...')
      await runAutoBuy()
  
      console.log('Fetching final balances...')
      await displayWalletBalances(WALLETS)
    } catch (err) {
      console.error('Fatal error:', err)
      process.exit(1)
    }
  })()