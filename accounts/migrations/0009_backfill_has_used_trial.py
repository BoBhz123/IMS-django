from django.db import migrations


def mark_existing_trials_as_used(apps, schema_editor):
    """
    Any account that already has a trial date has had its trial.

    Without this, every account created before 0008 keeps has_used_trial=False and is one
    admin status-reset away from a second free fortnight — the policy would apply only to
    signups from today onward, which is not what "one trial per account" means.

    `trial_ends_at` is the signal because it is set at signup and never cleared by ordinary
    code. The revoke action *does* clear it, so an account revoked before this migration ran
    is indistinguishable from one that never trialed and stays False. That is the safe
    direction to be wrong in: it grants a trial to someone whose subscription was cancelled
    by hand, rather than denying one to a legitimate new signup.
    """
    Account = apps.get_model('accounts', 'Account')
    Account.objects.filter(trial_ends_at__isnull=False).update(has_used_trial=True)


def unmark(apps, schema_editor):
    """Reverse is a no-op flag clear — the column is dropped by 0008's reverse anyway."""
    Account = apps.get_model('accounts', 'Account')
    Account.objects.update(has_used_trial=False)


class Migration(migrations.Migration):

    dependencies = [
        ('accounts', '0008_account_has_used_trial_userpaymentrecord'),
    ]

    operations = [
        migrations.RunPython(mark_existing_trials_as_used, unmark),
    ]
