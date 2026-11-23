//! litesvm end-to-end: init -> launch -> buy -> sell (fee routing) -> creator fees ->
//! commit/reveal -> settle (DIED) -> claim/sweep. Loads target/deploy/stovia.so.
use borsh::BorshSerialize;
use litesvm::LiteSVM;
use sha2::{Digest, Sha256};
use solana_sdk::{
    account::Account,
    bpf_loader_upgradeable,
    clock::Clock,
    instruction::{AccountMeta, Instruction},
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program, sysvar,
    transaction::Transaction,
};
use std::str::FromStr;

const SOL: u64 = 1_000_000_000;

fn pid() -> Pubkey {
    Pubkey::from_str("6f54qVP1zv9F36A5Cxj9ogzm5DSVY1pQFndZWTwcVL8").unwrap()
}
fn disc(name: &str) -> Vec<u8> {
    Sha256::digest(format!("global:{name}").as_bytes())[..8].to_vec()
}
fn ix(name: &str, args: impl BorshSerialize, accounts: Vec<AccountMeta>) -> Instruction {
    let mut data = disc(name);
    args.serialize(&mut data).unwrap();
    Instruction { program_id: pid(), accounts, data }
}
fn pda(seeds: &[&[u8]]) -> Pubkey {
    Pubkey::find_program_address(seeds, &pid()).0
}
fn w(k: Pubkey) -> AccountMeta {
    AccountMeta::new(k, false)
}
fn r(k: Pubkey) -> AccountMeta {
    AccountMeta::new_readonly(k, false)
}
fn send(svm: &mut LiteSVM, ixs: &[Instruction], payer: &Keypair, extra: &[&Keypair]) {
    let mut signers: Vec<&Keypair> = vec![payer];
    signers.extend_from_slice(extra);
    let tx = Transaction::new_signed_with_payer(ixs, Some(&payer.pubkey()), &signers, svm.latest_blockhash());
    match svm.send_transaction(tx) {
        Ok(_) => {}
        Err(e) => panic!("tx failed: {:?}\nlogs:\n{}", e.err, e.meta.logs.join("\n")),
    }
    svm.expire_blockhash();
}
fn bal(svm: &LiteSVM, k: &Pubkey) -> u64 {
    svm.get_balance(k).unwrap_or(0)
}
fn token_amount(svm: &LiteSVM, k: &Pubkey) -> u64 {
    let a = svm.get_account(k).unwrap();
    u64::from_le_bytes(a.data[64..72].try_into().unwrap())
}
fn set_time(svm: &mut LiteSVM, ts: i64) {
    let mut c: Clock = svm.get_sysvar();
    c.unix_timestamp = ts;
    c.slot += 1;
    svm.set_sysvar(&c);
}

/// Deploy as an upgradeable program so initialize_config's upgrade-authority gate works.
fn deploy(svm: &mut LiteSVM, authority: &Pubkey) {
    // litesvm 0.6 (agave 2.2 runtime) only loads SBPF v0-v2; build with
    // `cargo build-sbf --arch v0 --sbf-out-dir target/deploy-v0`, or point STOVIA_SO at a .so.
    let path = std::env::var("STOVIA_SO")
        .unwrap_or_else(|_| concat!(env!("CARGO_MANIFEST_DIR"), "/../target/deploy-v0/stovia.so").to_string());
    let elf = std::fs::read(&path).expect("missing program .so (see comment)");
    let (pd, _) = Pubkey::find_program_address(&[pid().as_ref()], &bpf_loader_upgradeable::id());
    let mut pd_data = vec![3u8, 0, 0, 0];
    pd_data.extend_from_slice(&0u64.to_le_bytes());
    pd_data.push(1);
    pd_data.extend_from_slice(authority.as_ref());
    pd_data.extend_from_slice(&elf);
    svm.set_account(pd, Account { lamports: 10 * SOL, data: pd_data, owner: bpf_loader_upgradeable::id(), executable: false, rent_epoch: 0 })
        .unwrap();
    let mut p_data = vec![2u8, 0, 0, 0];
    p_data.extend_from_slice(pd.as_ref());
    svm.set_account(pid(), Account { lamports: SOL, data: p_data, owner: bpf_loader_upgradeable::id(), executable: true, rent_epoch: 0 })
        .unwrap();
}

#[test]
fn launch_buy_sell_and_market() {
    let mut svm = LiteSVM::new();
    let admin = Keypair::new();
    let creator = Keypair::new();
    let trader = Keypair::new();
    let bettor_yes = Keypair::new();
    let bettor_no = Keypair::new();
    let treasury = Keypair::new().pubkey();
    for k in [&admin, &creator, &trader, &bettor_yes, &bettor_no] {
        svm.airdrop(&k.pubkey(), 100 * SOL).unwrap();
    }
    svm.airdrop(&treasury, SOL).unwrap();
    deploy(&mut svm, &admin.pubkey());
    let now = 1_800_000_000i64;
    set_time(&mut svm, now);

    let token_program = spl_token::id();
    let ata_program = spl_associated_token_account::id();
    let config = pda(&[b"config"]);
    let (programdata, _) = Pubkey::find_program_address(&[pid().as_ref()], &bpf_loader_upgradeable::id());

    // initialize_config: non-authority must fail is implied by constraint; happy path here.
    send(
        &mut svm,
        &[ix(
            "initialize_config",
            (treasury, 10u16, 10u16),
            vec![
                AccountMeta::new(admin.pubkey(), true),
                w(config),
                r(pid()),
                r(programdata),
                r(system_program::id()),
            ],
        )],
        &admin,
        &[],
    );

    // launch_token
    let mint = Keypair::new();
    let launch = pda(&[b"launch", mint.pubkey().as_ref()]);
    let curve_vault = pda(&[b"curve_vault", launch.as_ref()]);
    let curve_sol = pda(&[b"curve_sol", launch.as_ref()]);
    let bond_vault = pda(&[b"bond", launch.as_ref()]);
    let fee_vault = pda(&[b"creator_fee", launch.as_ref()]);
    let market = pda(&[b"market", launch.as_ref()]);
    let market_vault = pda(&[b"market_vault", launch.as_ref()]);
    let deadline = now + 3600;
    let t0 = bal(&svm, &treasury);
    send(
        &mut svm,
        &[ix(
            "launch_token",
            ("Doge Survive".to_string(), "DSRV".to_string(), "https://x/y.json".to_string(), SOL, 100 * SOL, deadline),
            vec![
                AccountMeta::new(creator.pubkey(), true),
                w(config),
                w(treasury),
                AccountMeta::new(mint.pubkey(), true),
                w(launch),
                w(curve_vault),
                w(curve_sol),
                w(bond_vault),
                w(fee_vault),
                w(market),
                w(market_vault),
                r(token_program),
                r(system_program::id()),
            ],
        )],
        &creator,
        &[&mint],
    );
    assert_eq!(bal(&svm, &treasury) - t0, 1_000_000, "0.1% of 1 SOL bond to treasury");
    assert_eq!(token_amount(&svm, &curve_vault), 1_000_000_000 * 1_000_000);
    let bond_rent = bal(&svm, &bond_vault) - 999_000_000;
    assert!(bond_rent > 0 && bond_rent < 2_000_000);

    let user_ata = spl_associated_token_account::get_associated_token_address(&trader.pubkey(), &mint.pubkey());
    let swap_accounts = |user: Pubkey| {
        vec![
            AccountMeta::new(user, true),
            r(config),
            w(treasury),
            w(launch),
            r(mint.pubkey()),
            w(curve_vault),
            w(curve_sol),
            w(fee_vault),
            w(market),
            w(user_ata),
            r(token_program),
            r(ata_program),
            r(system_program::id()),
        ]
    };

    // buy 1 SOL
    set_time(&mut svm, now + 60);
    let (t1, f1, c1) = (bal(&svm, &treasury), bal(&svm, &fee_vault), bal(&svm, &curve_sol));
    send(&mut svm, &[ix("buy", (SOL, 1u64), swap_accounts(trader.pubkey()))], &trader, &[]);
    assert_eq!(bal(&svm, &treasury) - t1, 1_000_000, "platform fee 0.1%");
    assert_eq!(bal(&svm, &fee_vault) - f1, 1_000_000, "creator fee 0.1%");
    assert_eq!(bal(&svm, &curve_sol) - c1, 998_000_000, "net into curve");
    let bought = token_amount(&svm, &user_ata);
    // expected: vt - ceil(vs*vt/(vs+net))
    let (vs, vt) = (30 * SOL as u128, 1_073_000_000_000_000u128);
    let new_vt = (vs * vt + (vs + 998_000_000) - 1) / (vs + 998_000_000);
    assert_eq!(bought as u128, vt - new_vt);

    // slippage guard
    {
        let tx = Transaction::new_signed_with_payer(
            &[ix("buy", (SOL, u64::MAX), swap_accounts(trader.pubkey()))],
            Some(&trader.pubkey()),
            &[&trader],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(tx).is_err());
        svm.expire_blockhash();
    }

    // sell half
    set_time(&mut svm, now + 120);
    let (t2, f2, u2, c2) = (bal(&svm, &treasury), bal(&svm, &fee_vault), bal(&svm, &trader.pubkey()), bal(&svm, &curve_sol));
    send(&mut svm, &[ix("sell", (bought / 2, 1u64), swap_accounts(trader.pubkey()))], &trader, &[]);
    let gross = c2 - bal(&svm, &curve_sol);
    let fee = gross * 10 / 10_000;
    assert_eq!(bal(&svm, &treasury) - t2, fee);
    assert_eq!(bal(&svm, &fee_vault) - f2, fee);
    assert_eq!(bal(&svm, &trader.pubkey()) + 5000 - u2, gross - 2 * fee, "seller receives net (minus tx fee)");
    assert_eq!(token_amount(&svm, &user_ata), bought - bought / 2);

    // creator claims fees
    let cr0 = bal(&svm, &creator.pubkey());
    send(
        &mut svm,
        &[ix("claim_creator_fees", (), vec![AccountMeta::new(creator.pubkey(), true), w(launch), w(fee_vault)])],
        &creator,
        &[],
    );
    assert_eq!(bal(&svm, &creator.pubkey()) + 5000 - cr0, 1_000_000 + fee);

    // commit bets: YES (survive) 1 SOL, NO (die) 2 SOL
    let commit = |b: &Keypair, side: u8, salt: [u8; 32]| -> [u8; 32] {
        let mut h = Sha256::new();
        h.update([side]);
        h.update(salt);
        h.update(b.pubkey().as_ref());
        h.finalize().into()
    };
    let bet_accounts = |b: &Keypair| {
        vec![
            AccountMeta::new(b.pubkey(), true),
            r(config),
            w(treasury),
            w(market),
            w(market_vault),
            w(pda(&[b"bet", market.as_ref(), b.pubkey().as_ref()])),
            r(system_program::id()),
        ]
    };
    let (salt_y, salt_n) = ([7u8; 32], [9u8; 32]);
    let t3 = bal(&svm, &treasury);
    send(&mut svm, &[ix("commit_bet", (commit(&bettor_yes, 1, salt_y), SOL), bet_accounts(&bettor_yes))], &bettor_yes, &[]);
    send(&mut svm, &[ix("commit_bet", (commit(&bettor_no, 2, salt_n), 2 * SOL), bet_accounts(&bettor_no))], &bettor_no, &[]);
    assert_eq!(bal(&svm, &treasury) - t3, 3_000_000, "0.1% bet fee");

    // reveal after deadline; wrong salt must fail
    set_time(&mut svm, deadline + 10);
    let reveal = |b: &Keypair| {
        vec![AccountMeta::new_readonly(b.pubkey(), true), w(market), w(pda(&[b"bet", market.as_ref(), b.pubkey().as_ref()]))]
    };
    {
        let tx = Transaction::new_signed_with_payer(
            &[ix("reveal_bet", (1u8, [0u8; 32]), reveal(&bettor_yes))],
            Some(&bettor_yes.pubkey()),
            &[&bettor_yes],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(tx).is_err(), "bad salt rejected");
        svm.expire_blockhash();
    }
    send(&mut svm, &[ix("reveal_bet", (1u8, salt_y), reveal(&bettor_yes))], &bettor_yes, &[]);
    send(&mut svm, &[ix("reveal_bet", (2u8, salt_n), reveal(&bettor_no))], &bettor_no, &[]);

    // settle after reveal window: TWAP ~28 SOL mcap < 100 SOL target => DIED, bond -> NO pool
    set_time(&mut svm, deadline + 24 * 3600 + 1);
    send(&mut svm, &[ix("settle_market", (), vec![w(market), w(bond_vault), w(market_vault)])], &admin, &[]);

    let n0 = bal(&svm, &bettor_no.pubkey());
    send(
        &mut svm,
        &[ix(
            "claim_winnings",
            (),
            vec![w(bettor_no.pubkey()), r(market), w(market_vault), w(pda(&[b"bet", market.as_ref(), bettor_no.pubkey().as_ref()]))],
        )],
        &admin,
        &[],
    );
    // NO stake 1.998 SOL + YES stake 0.999 SOL + bond 0.999 SOL
    assert_eq!(bal(&svm, &bettor_no.pubkey()) - n0, 1_998_000_000 + 999_000_000 + 999_000_000);

    // loser cannot claim
    {
        let tx = Transaction::new_signed_with_payer(
            &[ix(
                "claim_winnings",
                (),
                vec![w(bettor_yes.pubkey()), r(market), w(market_vault), w(pda(&[b"bet", market.as_ref(), bettor_yes.pubkey().as_ref()]))],
            )],
            Some(&admin.pubkey()),
            &[&admin],
            svm.latest_blockhash(),
        );
        assert!(svm.send_transaction(tx).is_err());
    }
    // market vault drained back to its rent floor
    let mv = svm.get_account(&market_vault).unwrap();
    assert!(mv.lamports < 2_000_000);
    let _ = sysvar::clock::id();
}
