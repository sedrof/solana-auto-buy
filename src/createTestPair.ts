import {
    Connection,
    Keypair,
    PublicKey,
    LAMPORTS_PER_SOL,
    Transaction,
    ComputeBudgetProgram,
  } from "@solana/web3.js";
  import {
    createMint,
    getOrCreateAssociatedTokenAccount,
    mintTo,
    NATIVE_MINT,
  } from "@solana/spl-token";
  import {
    TokenAmount,
    Token,
    Liquidity,
  } from "@raydium-io/raydium-sdk-v2";
  import dotenv from "dotenv";
  
  dotenv.config(); // Load environment variables
  
  const RPC_ENDPOINT = process.env.RPC_ENDPOINT || "";
  if (!RPC_ENDPOINT) throw new Error("Missing RPC_ENDPOINT");
  
  const PAYER_SECRET_KEY = process.env.PAYER_SECRET_KEY || "";
  if (!PAYER_SECRET_KEY) throw new Error("Missing PAYER_SECRET_KEY");
  
  const connection = new Connection(RPC_ENDPOINT, "confirmed");
  const payer = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(PAYER_SECRET_KEY))
  );
  
  async function createTestTokenAndPool() {
    console.log("Connecting to Solana Devnet...");
    console.log("Payer Address:", payer.publicKey.toBase58());
  
    const balance = await connection.getBalance(payer.publicKey);
    console.log("Payer Balance:", (balance / LAMPORTS_PER_SOL).toFixed(3), "SOL");
  
    // Step 1: Create a new token
    console.log("Creating token mint...");
    const tokenMint = await createMint(
      connection,
      payer,
      payer.publicKey,
      null,
      9 // Token decimals
    );
    console.log("Token Mint:", tokenMint.toBase58());
  
    // Step 2: Create an associated token account for the token
    console.log("Setting up token account...");
    const tokenAccount = await getOrCreateAssociatedTokenAccount(
      connection,
      payer,
      tokenMint,
      payer.publicKey
    );
    console.log("Token Account:", tokenAccount.address.toBase58());
  
    // Step 3: Mint tokens to the associated token account
    console.log("Minting tokens...");
    await mintTo(
      connection,
      payer,
      tokenMint,
      tokenAccount.address,
      payer,
      1000 * 10 ** 9 // Mint 1000 tokens
    );
    console.log("Minted 1000 tokens to:", tokenAccount.address.toBase58());
  
    // Step 4: Create a pool between SOL and the new token
    console.log("Creating pool...");
  
    const quoteToken = new Token(tokenMint, 9);
    const baseToken = new Token(NATIVE_MINT, 9);
  
    // Compute the pool ID.
    const poolId = Liquidity.computePoolId({
      baseMint: NATIVE_MINT,
      quoteMint: tokenMint,
      version: 4,
    });
    console.log("Computed Pool ID:", poolId.toBase58());
  
    const { innerTransactions } =
      await Liquidity.makeCreatePoolV4InstructionSimple({
        connection,
        poolKeys: {
          id: poolId,
          baseMint: NATIVE_MINT,
          quoteMint: tokenMint,
          baseVault: await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            baseToken.mint,
            poolId,
            true
          ).then((r) => r.address),
          quoteVault: await getOrCreateAssociatedTokenAccount(
            connection,
            payer,
            quoteToken.mint,
            poolId,
            true
          ).then((r) => r.address),
          version: 4,
          programId: new PublicKey(
            "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
          ), //mainnet: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8, devnet: 675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8
        },
        baseAmount: new TokenAmount(baseToken, "1", false), // 1 SOL
        quoteAmount: new TokenAmount(quoteToken, "500", false), // 500 tokens
        startTime: Math.floor(Date.now() / 1000),
        ownerInfo: {
          feePayer: payer,
          wallet: payer,
          tokenAccounts: [],
          useSOLBalance: true,
        },
        txVersion: 0,
      });
  
    // Process transactions
    for (const ix of innerTransactions) {
      const tx = new Transaction();
  
      // Add compute budget instruction
      tx.add(
        ComputeBudgetProgram.setComputeUnitLimit({
          units: 1000000,
        })
      );
  
      tx.add(...ix.instructions);
  
      const latestBlockhash = await connection.getLatestBlockhash();
      tx.recentBlockhash = latestBlockhash.blockhash;
      tx.feePayer = payer.publicKey;
  
      tx.sign(payer);
  
      const sig = await connection.sendRawTransaction(tx.serialize());
      console.log(
        `Transaction: https://explorer.solana.com/tx/${sig}?cluster=devnet`
      );
  
      await connection.confirmTransaction(sig);
    }
  
    console.log("Pool created successfully!");
  }
  
  (async () => {
    try {
      await createTestTokenAndPool();
    } catch (err) {
      console.error("Error:", err);
    }
  })();