from rest_framework import permissions

class FullDjangoModelPermissions(permissions.DjangoModelPermissions):
    def __init__(self) -> None:
        super().__init__()
        self.perms_map['GET'] = ['%(app_label)s.view_%(model_name)s']