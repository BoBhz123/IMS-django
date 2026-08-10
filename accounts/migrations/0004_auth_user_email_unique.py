from django.db import migrations


class Migration(migrations.Migration):
    """
    Django cannot cleanly AlterField another app's model, so the uniqueness guarantee for
    auth_user.email goes in as raw SQL — which also means it will never show up in
    `makemigrations` output.

    Functional and partial: LOWER(email) because Owner@x.com and owner@x.com are the same
    login now that username is derived from the address, and `WHERE email <> ''` because
    superusers created without an address would otherwise all collide on the empty string.
    """

    dependencies = [
        ('accounts', '0003_emailverification'),
        ('auth', '0012_alter_user_first_name_max_length'),
    ]

    operations = [
        migrations.RunSQL(
            sql="""
                CREATE UNIQUE INDEX uniq_auth_user_email_ci
                ON auth_user (LOWER(email))
                WHERE email <> '';
            """,
            reverse_sql='DROP INDEX IF EXISTS uniq_auth_user_email_ci;',
        ),
    ]
