//! litesvm: admin handoff, SURVIVED path (claim_bond + YES payout + sweep), sealed Privacy Rings bets.
mod common;
use common::*;
use litesvm::LiteSVM;
use solana_sdk::{
    instruction::AccountMeta,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    system_program,
};

const NOW: i64 = 1_800_000_000;

fn setup(n: usize) -> (LiteSVM, Keypair, Vec<Keypair>, Pubkey) {
    let mut svm = LiteSVM::new();
    let admin = Keypair::new();
    svm.airdrop(&admin.pubkey(), 100 * SOL).unwrap();
    let users: Vec<Keypair> = (0..n).map(|_| Keypair::new()).collect();
    for u in &users {
        svm.airdrop(&u.pubkey(), 100 * SOL).unwrap();
    }
    let treasury = Keypair::new().pubkey();
    svm.airdrop(&treasury, SOL).unwrap();
    deploy(&mut svm, &admin.pubkey());
    set_time(&mut svm, NOW);
    (svm, admin, users, treasury)
}

#[test]
fn admin_handoff() {
    let (mut svm, deployer, users, treasury) = setup(3);
    let (company, intruder, resolver) = (&users[0], &users[1], &users[2]);

    // Non-upgrade-authority cannot initialize.
    let err = try_send(&mut svm, &[init_config_ix(&intruder.pubkey(), treasury, None, resolver.pubkey())], intruder, &[]);
    assert!(err.is_err(), "non-upgrade-authority must not initialize");

    // Deployer initializes with the company wallet pre-nominated.
    send(&mut svm, &[init_config_ix(&deployer.pubkey(), treasury, Some(company.pubkey()), resolver.pubkey())], &deployer, &[]);
    let c = read_config(&svm);
    assert_eq!(c.admin, deployer.pubkey());
    assert_eq!(c.pending_admin, Some(company.pubkey()));
    assert_eq!(c.resolver, resolver.pubkey());
    assert_eq!(c.treasury, treasury);

    // Second initialize fails (PDA exists).
    assert!(try_send(&mut svm, &[init_config_ix(&deployer.pubkey(), treasury, None, resolver.pubkey())], &deployer, &[]).is_err());

    let config = pda(&[b"config"]);
    let accept = |k: &Keypair| ix("accept_admin", (), vec![AccountMeta::new_readonly(k.pubkey(), true), w(config)]);
    let admin_ix = |name: &str, k: &Keypair, arg: Pubkey| ix(name, arg, vec![AccountMeta::new_readonly(k.pubkey(), true), w(config)]);

    // Wrong signer cannot accept, nor propose.
    assert!(try_send(&mut svm, &[accept(intruder)], intruder, &[]).is_err(), "non-nominee accept rejected");
    assert!(try_send(&mut svm, &[admin_ix("propose_admin", intruder, intruder.pubkey())], intruder, &[]).is_err());
    assert!(try_send(&mut svm, &[admin_ix("set_resolver", intruder, intruder.pubkey())], intruder, &[]).is_err());

    // Company accepts.
    send(&mut svm, &[accept(company)], company, &[]);
    let c = read_config(&svm);
    assert_eq!(c.admin, company.pubkey());
    assert_eq!(c.pending_admin, None);

    // Accept is not replayable; old admin lost rights.
    assert!(try_send(&mut svm, &[accept(company)], company, &[]).is_err());
    let upd = |k: &Keypair| {
        ix("update_config", (treasury, 20u16, 20u16), vec![AccountMeta::new_readonly(k.pubkey(), true), w(config)])
    };
    assert!(try_send(&mut svm, &[upd(&deployer)], &deployer, &[]).is_err(), "old admin can't update_config");
    send(&mut svm, &[upd(company)], company, &[]);

    // Propose / accept again via propose_admin (company -> intruder-as-new), and set_resolver.
    let new_resolver = Keypair::new().pubkey();
    send(&mut svm, &[admin_ix("set_resolver", company, new_resolver)], company, &[]);
    assert_eq!(read_config(&svm).resolver, new_resolver);
    assert!(try_send(&mut svm, &[admin_ix("propose_admin", company, Pubkey::default())], company, &[]).is_err());
    send(&mut svm, &[admin_ix("propose_admin", company, intruder.pubkey())], company, &[]);
    assert_eq!(read_config(&svm).pending_admin, Some(intruder.pubkey()));
    assert!(try_send(&mut svm, &[accept(&deployer)], &deployer, &[]).is_err());
    send(&mut svm, &[accept(intruder)], intruder, &[]);
    assert_eq!(read_config(&svm).admin, intruder.pubkey());
}

#[test]
fn survived_claim_bond_yes_payout_and_sweep() {
    let (mut svm, admin, users, treasury) = setup(4);
    let (creator, yes, no, lazy) = (&users[0], &users[1], &users[2], &users[3]);
    send(&mut svm, &[init_config_ix(&admin.pubkey(), treasury, None, admin.pubkey())], &admin, &[]);
    let deadline = NOW + 3600;
    // Starting mcap ~27.96 SOL; target 20 SOL => SURVIVED without trades.
    let k = launch(&mut svm, creator, treasury, SOL, 20 * SOL, deadline);
    let config = pda(&[b"config"]);
    let bet_pda = |b: &Keypair| pda(&[b"bet", k.market.as_ref(), b.pubkey().as_ref()]);
    let commit = |b: &Keypair, side: u8, salt: [u8; 32], amt: u64| {
        ix(
            "commit_bet",
            (side_commitment(side, salt, &b.pubkey()), amt),
            vec![
                AccountMeta::new(b.pubkey(), true),
                r(config),
                w(treasury),
                w(k.market),
                w(k.market_vault),
                w(bet_pda(b)),
                r(system_program::id()),
            ],
        )
    };
    send(&mut svm, &[commit(yes, 1, [1; 32], SOL)], yes, &[]);
    send(&mut svm, &[commit(no, 2, [2; 32], 3 * SOL)], no, &[]);
    send(&mut svm, &[commit(lazy, 2, [3; 32], 2 * SOL)], lazy, &[]); // never reveals

    // claim_bond before settle fails.
    let claim_bond = ix(
        "claim_bond",
        (),
        vec![AccountMeta::new(creator.pubkey(), true), r(k.launch), w(k.market), w(k.bond_vault)],
    );
    assert!(try_send(&mut svm, &[claim_bond.clone()], creator, &[]).is_err());

    set_time(&mut svm, deadline + 5);
    let reveal = |b: &Keypair, side: u8, salt: [u8; 32]| {
        ix("reveal_bet", (side, salt), vec![AccountMeta::new_readonly(b.pubkey(), true), w(k.market), w(bet_pda(b))])
    };
    send(&mut svm, &[reveal(yes, 1, [1; 32])], yes, &[]);
    send(&mut svm, &[reveal(no, 2, [2; 32])], no, &[]);

    // settle too early fails, then succeeds after the reveal window.
    let settle = ix("settle_market", (), vec![w(k.market), w(k.bond_vault), w(k.market_vault)]);
    assert!(try_send(&mut svm, &[settle.clone()], &admin, &[]).is_err());
    set_time(&mut svm, deadline + 24 * 3600 + 1);
    send(&mut svm, &[settle], &admin, &[]);
    let md = svm.get_account(&k.market).unwrap().data;
    assert_eq!(md[161], 1, "status == Survived");

    // Creator reclaims bond (net of 0.1% fee) exactly once.
    let c0 = bal(&svm, &creator.pubkey());
    send(&mut svm, &[claim_bond.clone()], creator, &[]);
    assert_eq!(bal(&svm, &creator.pubkey()) + 5000 - c0, 999_000_000);
    assert!(try_send(&mut svm, &[claim_bond], creator, &[]).is_err(), "bond claimed twice");

    // YES winner: stake 0.999 + 0.999 * 2.997 / 0.999 = 0.999 + 2.997 SOL. No bonus on SURVIVED.
    let claim = |b: &Keypair| {
        ix("claim_winnings", (), vec![w(b.pubkey()), r(k.market), w(k.market_vault), w(bet_pda(b))])
    };
    let y0 = bal(&svm, &yes.pubkey());
    send(&mut svm, &[claim(yes)], &admin, &[]);
    assert_eq!(bal(&svm, &yes.pubkey()) - y0, 999_000_000 + 2_997_000_000);
    assert!(try_send(&mut svm, &[claim(yes)], &admin, &[]).is_err(), "double claim");
    assert!(try_send(&mut svm, &[claim(no)], &admin, &[]).is_err(), "loser");
    assert!(try_send(&mut svm, &[claim(lazy)], &admin, &[]).is_err(), "unrevealed");

    // Sweep unrevealed (lazy's 1.998 SOL) to treasury, once.
    let sweep = ix("sweep_unrevealed", (), vec![r(config), w(treasury), w(k.market), w(k.market_vault)]);
    let t0 = bal(&svm, &treasury);
    send(&mut svm, &[sweep.clone()], &admin, &[]);
    assert_eq!(bal(&svm, &treasury) - t0, 1_998_000_000);
    assert!(try_send(&mut svm, &[sweep], &admin, &[]).is_err(), "double sweep");
    let mv = svm.get_account(&k.market_vault).unwrap();
    assert!(mv.lamports < 2_000_000, "vault back to rent floor");
}

#[test]
fn sealed_bets_commit_reveal_post_results() {
    let (mut svm, admin, users, treasury) = setup(5);
    let (creator, a, b, resolver, intruder) = (&users[0], &users[1], &users[2], &users[3], &users[4]);
    send(&mut svm, &[init_config_ix(&admin.pubkey(), treasury, None, resolver.pubkey())], &admin, &[]);
    let deadline = NOW + 3600;
    let k = launch(&mut svm, creator, treasury, SOL, 100 * SOL, deadline); // will DIE
    let sb = |u: &Keypair| pda(&[b"sealed_bet", k.market.as_ref(), u.pubkey().as_ref()]);
    let commit = |u: &Keypair, side: u8, salt: [u8; 32], amt: u64, salt2: [u8; 32]| {
        ix(
            "commit_sealed_bet",
            (side_commitment(side, salt, &u.pubkey()), stake_commitment(amt, salt2, &u.pubkey())),
            vec![AccountMeta::new(u.pubkey(), true), w(k.market), w(sb(u)), r(system_program::id())],
        )
    };

    // Commit: only rent leaves the bettor; treasury and market vault untouched.
    let (a0, t0, mv0) = (bal(&svm, &a.pubkey()), bal(&svm, &treasury), bal(&svm, &k.market_vault));
    send(&mut svm, &[commit(a, 1, [11; 32], 5 * SOL, [12; 32])], a, &[]);
    let sb_rent = bal(&svm, &sb(a));
    assert_eq!(a0 - bal(&svm, &a.pubkey()), sb_rent + 5000, "only rent + tx fee");
    assert!(sb_rent < 2_000_000);
    assert_eq!(bal(&svm, &treasury), t0);
    assert_eq!(bal(&svm, &k.market_vault), mv0);
    // Stake commitment stored, amount nowhere in the account.
    let d = svm.get_account(&sb(a)).unwrap().data;
    assert_eq!(&d[104..136], &stake_commitment(5 * SOL, [12; 32], &a.pubkey()));
    assert!(!d.windows(8).any(|w| w == (5 * SOL).to_le_bytes()));

    // One per bettor per market.
    assert!(try_send(&mut svm, &[commit(a, 2, [13; 32], SOL, [14; 32])], a, &[]).is_err());
    send(&mut svm, &[commit(b, 2, [21; 32], 2 * SOL, [22; 32])], b, &[]);

    // Reveal before deadline fails.
    let reveal = |u: &Keypair, side: u8, salt: [u8; 32]| {
        ix("reveal_sealed_bet", (side, salt), vec![AccountMeta::new_readonly(u.pubkey(), true), w(k.market), w(sb(u))])
    };
    assert!(try_send(&mut svm, &[reveal(a, 1, [11; 32])], a, &[]).is_err());

    // Commit after deadline fails.
    set_time(&mut svm, deadline + 1);
    let late = Keypair::new();
    svm.airdrop(&late.pubkey(), SOL).unwrap();
    assert!(try_send(&mut svm, &[commit(&late, 1, [1; 32], 1, [1; 32])], &late, &[]).is_err());

    // Wrong salt / wrong side rejected; correct reveal ok; double reveal rejected.
    assert!(try_send(&mut svm, &[reveal(a, 1, [0; 32])], a, &[]).is_err());
    assert!(try_send(&mut svm, &[reveal(a, 2, [11; 32])], a, &[]).is_err());
    send(&mut svm, &[reveal(a, 1, [11; 32])], a, &[]);
    assert!(try_send(&mut svm, &[reveal(a, 1, [11; 32])], a, &[]).is_err());
    send(&mut svm, &[reveal(b, 2, [21; 32])], b, &[]);
    let d = svm.get_account(&sb(a)).unwrap().data;
    assert_eq!(d[136], 1, "side stored");
    assert_eq!(d[137], 1, "revealed");
    let md = svm.get_account(&k.market).unwrap().data;
    assert_eq!(u32::from_le_bytes(md[163..167].try_into().unwrap()), 2, "sealed_committed");
    assert_eq!(u32::from_le_bytes(md[167..171].try_into().unwrap()), 2, "sealed_revealed");

    // post_sealed_results before settle fails (even for the resolver).
    let results = pda(&[b"sealed_results", k.market.as_ref()]);
    let root = [0xabu8; 32];
    let post = |s: &Keypair| {
        ix(
            "post_sealed_results",
            (5 * SOL, 2 * SOL, root),
            vec![AccountMeta::new(s.pubkey(), true), r(pda(&[b"config"])), r(k.market), w(results), r(system_program::id())],
        )
    };
    assert!(try_send(&mut svm, &[post(resolver)], resolver, &[]).is_err(), "before settle");

    set_time(&mut svm, deadline + 24 * 3600 + 1);
    send(&mut svm, &[ix("settle_market", (), vec![w(k.market), w(k.bond_vault), w(k.market_vault)])], &admin, &[]);

    // Non-resolver (incl. admin) rejected; resolver posts once.
    assert!(try_send(&mut svm, &[post(intruder)], intruder, &[]).is_err(), "intruder");
    assert!(try_send(&mut svm, &[post(&admin)], &admin, &[]).is_err(), "admin is not resolver");
    send(&mut svm, &[post(resolver)], resolver, &[]);
    assert!(try_send(&mut svm, &[post(resolver)], resolver, &[]).is_err(), "once only");
    let rd = svm.get_account(&results).unwrap().data;
    assert_eq!(Pubkey::try_from(&rd[8..40]).unwrap(), k.market);
    assert_eq!(Pubkey::try_from(&rd[40..72]).unwrap(), resolver.pubkey());
    assert_eq!(rd[72], 0, "DIED");
    assert_eq!(u64::from_le_bytes(rd[73..81].try_into().unwrap()), 5 * SOL);
    assert_eq!(u64::from_le_bytes(rd[81..89].try_into().unwrap()), 2 * SOL);
    assert_eq!(&rd[89..121], &root);

    // Public path unaffected: market vault still at rent floor (no sealed SOL escrowed).
    assert_eq!(bal(&svm, &k.market_vault), mv0 + SOL - 1_000_000, "only the DIED bond moved in");
}
